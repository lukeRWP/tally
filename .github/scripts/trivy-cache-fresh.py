#!/usr/bin/env python3
"""Is the Trivy data in TRIVY_CACHE_DIR present, parseable and recent?

    trivy-cache-fresh.py db       the vulnerability database
    trivy-cache-fresh.py checks   the misconfig checks bundle

Exit 0 = yes, that subject may be scanned against. Exit 1 = no, with the reason
on stderr. Nothing here downloads, repairs or retries: this is the *check*, and
the trivy.yml workflow runs each subject twice — once to decide whether to fall
back to a live download, and once afterwards as an unconditional assertion.

Why the check exists at all
---------------------------
The scan steps run with TRIVY_SKIP_DB_UPDATE=true and TRIVY_SKIP_CHECK_UPDATE=
true so each download happens exactly once, in a step that can retry it, instead
of once per scan where a network blip reddens a security gate for no security
reason. The cost is that Trivy no longer decides for itself whether its data is
usable — and Trivy's reaction to unusable data is quiet either way:

  * DB — given a cached DB of any age it scans against it, reports "no
    vulnerabilities found", and says nothing about the age. Verified against
    trivy v0.70.0 with a DB backdated 20 days: clean table, exit 0, not one
    warning.
  * checks bundle — when it cannot be fetched, or is simply absent from the
    cache, trivy logs `ERROR [misconfig] Falling back to embedded checks` and
    scans on with the narrower rego set compiled into the binary. Exit 0, green
    job, no summary line anywhere saying misconfig coverage was reduced (#334).
    The v2 bundle is 580 rego checks; nothing reports what the fallback holds.

Both failures produce a green gate that has quietly stopped covering things, so
freshness is asserted here, out loud, instead of being inferred from a cache
hit. `actions/cache` restore-keys will happily serve last week's cache when
today's key misses, so a cache hit on its own proves nothing about age.

Where the timestamps come from
------------------------------
<cache-dir>/db/metadata.json, next to trivy.db:

    {"Version":2,
     "NextUpdate":"2026-08-31T07:05:29.616303372Z",
     "UpdatedAt":"2026-08-30T07:05:29.616303622Z",
     "DownloadedAt":"2026-08-30T13:04:55.459281Z"}

UpdatedAt is when upstream *built* the DB; DownloadedAt is when this runner
fetched it. DB age is measured from UpdatedAt because that is the one that
bounds which CVEs the DB can possibly know about — a fresh download of an old
build is still an old build.

<cache-dir>/policy/metadata.json, next to the extracted content/ tree:

    {"Digest":"sha256:1583562f8b90…","DownloadedAt":"2026-08-30T09:27:46.774485-04:00","MajorVersion":2}

The bundle records no upstream build time, only the digest it resolved to, so
its age can only be measured from DownloadedAt. That bound is weaker than the
DB's: it says how long ago this cache line was last confirmed against upstream,
not how old the checks in it are. It is still worth holding, because without it
a restored bundle is re-saved under each new day's cache key indefinitely and
misconfig coverage freezes at whatever was cached first, with nothing to say so.

The ceilings
------------
DB_MAX_AGE_HOURS (48) is deliberately looser than Trivy's own 24h refresh hint
so that an ordinary same-day cache hit is not churned into a re-download, and it
is the figure prevailing-winds#315 specifies. The honest cost: a scan may run
against a DB up to 48h old where Trivy left to itself would have refreshed at
24h. What it buys is a bound that is stated, checked and logged on every run
rather than implied.

CHECKS_MAX_AGE_HOURS (48) matches it. The bundle is ~235 KiB and fetches in
about a second, so the re-download this forces every second day costs nothing
worth counting. Tighten either by lowering the value in trivy.yml; nothing else
has to change.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

CACHE_DIR = os.environ.get("TRIVY_CACHE_DIR", "")

# Trivy's Go timestamps carry nanoseconds; datetime.fromisoformat tops out at
# microseconds, so trim the fraction to 6 digits and spell UTC as +00:00.
_FRACTION = re.compile(r"(\.\d{6})\d+")


def fail(subject: str, reason: str) -> "None":
    print(f"Trivy {subject} is NOT usable: {reason}", file=sys.stderr)
    sys.exit(1)


def load_metadata(subject: str, path: str) -> dict:
    if not os.path.isfile(path):
        fail(subject, f"{path} does not exist.")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as exc:
        fail(subject, f"{path} could not be read as JSON: {exc}")


def age_hours(subject: str, path: str, meta: dict, field: str) -> "tuple[str, float]":
    """(raw timestamp, hours since it) — or fail() if missing or unparseable."""
    raw = meta.get(field)
    if not raw:
        fail(subject, f"{path} has no {field} field: {meta!r}")

    try:
        stamp = datetime.fromisoformat(
            _FRACTION.sub(r"\1", str(raw)).replace("Z", "+00:00")
        )
    except ValueError as exc:
        fail(subject, f"{path} {field} {raw!r} is not a timestamp: {exc}")
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)

    hours = (datetime.now(timezone.utc) - stamp).total_seconds() / 3600

    # A timestamp in the future means a corrupt file or a wrong clock, and
    # either way the age is not something to reason from. One hour of slack
    # absorbs ordinary skew; past that, refuse rather than treat it as very
    # fresh.
    if hours < -1:
        fail(subject, f"{field} {raw} is {-hours:.1f}h in the future — bad clock or corrupt metadata.")
    return str(raw), hours


def check_db() -> "None":
    ceiling = float(os.environ.get("DB_MAX_AGE_HOURS", "48"))
    db = os.path.join(CACHE_DIR, "db", "trivy.db")
    metadata = os.path.join(CACHE_DIR, "db", "metadata.json")

    if not os.path.isfile(db):
        fail("DB", f"{db} does not exist.")

    meta = load_metadata("DB", metadata)
    built, hours = age_hours("DB", metadata, meta, "UpdatedAt")
    if hours > ceiling:
        fail(
            "DB",
            f"built {built} = {hours:.1f}h old, over the {ceiling:.0f}h ceiling. "
            "It cannot know about anything disclosed since.",
        )

    print(f"Trivy DB built {built} ({hours:.1f}h old), within the {ceiling:.0f}h ceiling.")


def check_checks() -> "None":
    ceiling = float(os.environ.get("CHECKS_MAX_AGE_HOURS", "48"))
    content = os.path.join(CACHE_DIR, "policy", "content")
    metadata = os.path.join(CACHE_DIR, "policy", "metadata.json")

    # This exact directory is what trivy tests before it gives up: with
    # --skip-check-update it says `failed to check cache: cache does not exist
    # at ".../policy/content"` and falls back to embedded checks, exit 0.
    if not os.path.isdir(content):
        fail("checks bundle", f"{content} does not exist.")

    # Presence of the directory is not presence of the checks. A half-extracted
    # bundle would satisfy trivy's own test and then quietly scan with less. If
    # upstream ever ships the checks in some form other than rego, this fails
    # loudly and someone updates this line — which is the correct direction for
    # a coverage guard to be wrong in.
    rego = sum(
        1
        for _, _, files in os.walk(content)
        for name in files
        if name.endswith(".rego")
    )
    if rego == 0:
        fail("checks bundle", f"{content} holds no .rego checks, so nothing was extracted into it.")

    meta = load_metadata("checks bundle", metadata)
    fetched, hours = age_hours("checks bundle", metadata, meta, "DownloadedAt")
    if hours > ceiling:
        fail(
            "checks bundle",
            f"last confirmed against upstream {fetched} = {hours:.1f}h ago, over the "
            f"{ceiling:.0f}h ceiling. Re-fetch it rather than scan with checks nobody has rechecked.",
        )

    print(
        f"Trivy checks bundle {meta.get('Digest', '<no digest>')}: {rego} rego checks, "
        f"fetched {fetched} ({hours:.1f}h ago), within the {ceiling:.0f}h ceiling."
    )


SUBJECTS = {"db": check_db, "checks": check_checks}


def main() -> "None":
    if len(sys.argv) != 2 or sys.argv[1] not in SUBJECTS:
        print(f"usage: {sys.argv[0]} {{{'|'.join(SUBJECTS)}}}", file=sys.stderr)
        sys.exit(2)

    subject = sys.argv[1]
    if not CACHE_DIR:
        fail(subject, "TRIVY_CACHE_DIR is not set, so there is nothing to check.")

    SUBJECTS[subject]()


if __name__ == "__main__":
    main()
