# Printer Bring-Up — Findings (Cycle 1)

**Status:** Complete. Hardware prints correctly.
**Date:** 2026-08-05
**Purpose:** This is the recorded output of the Cycle 1 bring-up — which backend won, the exact steps, and every correction the physical prints forced. **It is the input to the appliance image build.**

## Hardware as found

| | |
|---|---|
| Pi | Raspberry Pi 3 Model B |
| OS | Raspberry Pi OS Lite **64-bit**, Debian 13 (trixie) |
| `uname -m` | `aarch64` |
| CUPS | 2.4.10-3+rpt2+deb13u2 |
| Printer USB ID | **`09c6:0248`** — *not* the `09c6:0426` the research predicted |
| Device node | `/dev/usb/lp0`, `usblp` module loaded, `root:lp` mode 660 |

The VID:PID discrepancy matters: a udev rule hardcoded to `0426` would leave a silently dead printer.

## Backend decision: B (`pdf2tspl`), not A (CUPS + Rollo)

**Backend A was abandoned, not chosen against on merit.** Rollo's CDN returns **HTTP 403** to every request for `rollo-cups-driver_1.8.4-1_arm64.deb`, including with a browser user-agent and referer. The Pi's general internet is fine (github.com → 200), so this is deliberate blocking, not a network fault.

The documented fallback — building `nelullc/rollo-cups-driver` from source — was **not taken**: it means running an unaudited third-party build system as root, and the operator chose to avoid vendor code entirely.

**Backend B is what ships.** A hand-written `pdf2tspl` (~180 lines of Python): rasterise with poppler `pdftoppm` at 203 dpi, convert each page to a TSPL `BITMAP`, write the job in one burst. No vendor binaries, no root install, no CUPS driver, fully auditable — and an appliance image can rebuild it from source.

Worth noting for the record: the Rollo PPD (inspected before the source build was declined) already carries `*HWMargins: 0 0 0 0`, Custom page-size support, and built-in `4x6 = [288 432]` / `2x1 = [144 72]` — the last matching our presets exactly, which independently corroborated the Phase 1 geometry.

## Working configuration

```bash
sudo apt-get install -y cups libcupsimage2 poppler-utils   # poppler is the real dependency
sudo usermod -aG lp "$USER"                                # write access to /dev/usb/lp0
python3 pdf2tspl.py --size large --density 12 label.pdf    # small | medium | large
```

`libcups2-dev` exists un-renamed on Trixie (the `t64` rename does **not** apply to it).
CUPS itself is **not required** by backend B — it was installed during investigation and can be dropped from the image.

### Verified geometry

`BITMAP 0,0,102,1218` for a 4×6 → 102 bytes = 816 dots wide, **1218 dots = exactly 6.000″ at 203 dpi**. True size, no scaling.

## Corrections the physical prints forced

Every one of these was invisible on screen and only appeared on paper.

1. **No greys anywhere on a thermal label.** The head is 1-bit; `#333`/`#666` text and `#f0f0f0` row shading were dithered into stipple. Small text read as washed out and the list looked striped. All thermal fills are now pure black; the zebra shading is gone. *(The Avery sheet keeps its greys — it goes to a laser.)*
2. **QR must be generated at one image pixel per printer dot** — `(pt/72)*203`. It was made at an arbitrary 3× and resampled, smearing module edges into greys that then dithered. This is why it would not scan.
3. **Knockout text must be over-set.** Thermal bleed burns black into white letterforms, thinning them. Banner type went 13pt → 21pt with 7pt tracking in a 36pt bar before it read correctly on paper.
4. **Density 12** (of 15). 8 was too light for solid blacks.
5. **Barcode modules must snap to whole dots**, for exactly the same reason as the QR.

## Hazards confirmed live

- **`SIZE`/`GAP` persist in printer NVRAM**, so they are re-sent on every page. Not yet stress-tested across a roll swap — see open items.
- **Burst-write, never stream** — the firmware drops data arriving mid-print. The whole job is buffered and written in one call.
- **Recalibrate after every roll change** (hold feed until it beeps). A mis-loaded roll produced a garbled first print.

## Open items

- **2×1 and 3×3 are unprinted.** Only 4×6 has been proven. The per-job `SIZE`/`GAP` NVRAM claim is therefore untested across an actual size change — that is the single most important remaining hardware check.
- **QR and barcode scannability unconfirmed** by an actual phone scan.
- **No offset correction measured.** Nothing suggested one was needed, but nothing was measured against a ruler either.
- The client scanner (`html5-qrcode`, ZXing-based) will need **Code 128 added to `formatsToSupport`** to read the new barcode.

## Artifacts

- `pdf2tspl.py` — the print path (to be vendored into the `tally-printer` repo)
- `tally-printer-bringup.sh` — environment prep; its CUPS/Rollo section is now moot under backend B
- `server/src/modules/labels/code128.js` — Code 128 encoder used by the renderer
