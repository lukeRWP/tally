#!/usr/bin/env python3
"""
pdf2tspl — print a PDF on a TSPL/TSPL2 thermal label printer (Munbyn ITPP941).

Rasterises with poppler's pdftoppm, converts each page to a TSPL BITMAP, and
writes the whole job to the printer device in one burst.

    pdf2tspl.py --size 4x6 label.pdf                 # print
    pdf2tspl.py --size 2x1 --out job.bin label.pdf   # dump bytes, print nothing

Why this exists rather than a CUPS driver: the ITPP941 is a Rollo clone that
stock CUPS cannot drive, and the vendor driver is unreachable (CDN 403s). This
path has no vendor binaries and no root install, so an appliance image can
rebuild it from source and audit every byte.

Three hardware facts drive the design:

  * SIZE and GAP live in printer NVRAM and PERSIST between jobs. A 4x6 job
    silently corrupts the next 2x1 job unless both are re-sent every time, so
    they are emitted per page, never once at setup.
  * The firmware drops data arriving while it prints, which shows up as "the
    first label prints and the rest vanish". The whole job is buffered and
    written in ONE call, never streamed.
  * TSPL bitmap bits are inverted relative to PBM: TSPL burns a dot for a 0
    bit, while PBM P4 uses 1 for black. Every byte is complemented.

Unlike upstream pdf2tspl, this handles MULTI-PAGE documents — tally's 4x6
contents manifests paginate, and upstream's -singlefile only ever emits page 1.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

DPI = 203  # the ITPP941 head is 203 dpi; any other value scales the label

# Physical sizes keyed by the Phase 1 preset names, so one vocabulary runs from
# the tally UI all the way to the printer.
SIZES = {
    "small":  (2.0, 1.0),
    "medium": (3.0, 3.0),
    "large":  (4.0, 6.0),
    "2x1":    (2.0, 1.0),
    "3x3":    (3.0, 3.0),
    "4x6":    (4.0, 6.0),
}


def parse_pbm(data: bytes):
    """Parse a binary PBM (P4) -> (width, height, rows of packed bytes).

    P4 is: magic, whitespace-separated width and height, one whitespace byte,
    then rows padded to a byte boundary, MSB first, 1 = black. Comments (#...)
    may appear anywhere in the header, so the parser is tokenising rather than
    assuming a fixed two-line header.
    """
    if not data.startswith(b"P4"):
        raise ValueError("not a binary PBM (expected P4 magic)")

    pos = 2
    fields = []
    while len(fields) < 2:
        while pos < len(data) and data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b"#":                    # skip a comment line
            while pos < len(data) and data[pos] != 0x0A:
                pos += 1
            continue
        start = pos
        while pos < len(data) and not data[pos:pos + 1].isspace():
            pos += 1
        fields.append(int(data[start:pos]))
    pos += 1                                             # exactly one whitespace byte

    width, height = fields
    stride = (width + 7) // 8
    expected = stride * height
    body = data[pos:pos + expected]
    if len(body) != expected:
        raise ValueError(f"truncated PBM: wanted {expected} bytes, got {len(body)}")
    return width, height, [body[r * stride:(r + 1) * stride] for r in range(height)]


def page_to_tspl(width: int, height: int, rows, w_in: float, h_in: float,
                 density: int, speed: int) -> bytes:
    """One rasterised page -> one TSPL label."""
    stride = (width + 7) // 8

    out = bytearray()
    # SIZE and GAP first, on every page — they persist in NVRAM otherwise.
    # GAP 0,0 suits continuous stock; die-cut rolls track the gap sensor after
    # the physical feed-button calibration, which this does not replace.
    out += f"SIZE {w_in},{h_in}\r\n".encode()
    out += b"GAP 0,0\r\n"
    out += f"DENSITY {density}\r\n".encode()
    out += f"SPEED {speed}\r\n".encode()
    out += b"DIRECTION 1\r\n"
    out += b"REFERENCE 0,0\r\n"
    out += b"CLS\r\n"
    # BITMAP x,y,width_in_bytes,height_in_dots,mode(0=OVERWRITE),<raw bytes>
    out += f"BITMAP 0,0,{stride},{height},0,".encode()
    for row in rows:
        out += bytes(b ^ 0xFF for b in row)   # PBM 1=black -> TSPL 0=burn
    out += b"\r\n"
    out += b"PRINT 1,1\r\n"
    return bytes(out)


def render(pdf_path: str, w_in: float, h_in: float, density: int, speed: int) -> bytes:
    if not shutil.which("pdftoppm"):
        sys.exit("pdftoppm not found — install poppler-utils")

    job = bytearray()
    with tempfile.TemporaryDirectory() as tmp:
        prefix = os.path.join(tmp, "page")
        # -mono gives 1-bit PBM; -r pins the raster to the head's native dpi so
        # the label prints at true size. Deliberately no -singlefile: manifests
        # span pages. No scaling flags, ever.
        subprocess.run(
            ["pdftoppm", "-mono", "-r", str(DPI), pdf_path, prefix],
            check=True, capture_output=True,
        )
        pages = sorted(
            (f for f in os.listdir(tmp) if f.endswith(".pbm")),
            key=lambda f: int(re.search(r"(\d+)\.pbm$", f).group(1)),
        )
        if not pages:
            sys.exit("pdftoppm produced no pages")

        for name in pages:
            with open(os.path.join(tmp, name), "rb") as fh:
                width, height, rows = parse_pbm(fh.read())
            job += page_to_tspl(width, height, rows, w_in, h_in, density, speed)

    print(f"  rendered {len(pages)} page(s) -> {len(job)} bytes of TSPL", file=sys.stderr)
    return bytes(job)


def main():
    ap = argparse.ArgumentParser(description="Print a PDF on a TSPL label printer")
    ap.add_argument("pdf")
    ap.add_argument("--size", default="large",
                    help="small|medium|large or WxH inches (default: large)")
    ap.add_argument("--device", default="/dev/usb/lp0")
    ap.add_argument("--out", help="write TSPL to this file instead of printing")
    ap.add_argument("--density", type=int, default=8, help="burn density 0-15 (default 8)")
    ap.add_argument("--speed", type=int, default=4, help="print speed (default 4)")
    args = ap.parse_args()

    key = args.size.lower()
    if key in SIZES:
        w_in, h_in = SIZES[key]
    else:
        m = re.fullmatch(r"([\d.]+)x([\d.]+)", key)
        if not m:
            sys.exit(f"unrecognised --size {args.size!r}; use small|medium|large or WxH")
        w_in, h_in = float(m.group(1)), float(m.group(2))

    job = render(args.pdf, w_in, h_in, args.density, args.speed)

    if args.out:
        with open(args.out, "wb") as fh:
            fh.write(job)
        print(f"wrote {args.out} ({len(job)} bytes) — nothing printed", file=sys.stderr)
        return

    # One burst. Streaming loses whatever the firmware drops while printing.
    try:
        with open(args.device, "wb") as fh:
            fh.write(job)
            fh.flush()
    except PermissionError:
        sys.exit(f"cannot write {args.device} — add your user to the 'lp' group and re-login")
    except FileNotFoundError:
        sys.exit(f"{args.device} not found — is the printer plugged in and usblp loaded?")
    print(f"sent {len(job)} bytes to {args.device}", file=sys.stderr)


if __name__ == "__main__":
    main()
