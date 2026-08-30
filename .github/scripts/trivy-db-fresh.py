#!/usr/bin/env python3
"""Is the Trivy vulnerability DB in TRIVY_CACHE_DIR present, parseable and recent?

Exit 0 = yes, the DB may be scanned against. Exit 1 = no, with the reason on
stderr. Nothing here downloads, repairs or retries: this is the *check*, and the
trivy.yml workflow uses the same check twice — once to decide whether to fall
back to a live DB pull, and once afterwards as an unconditional assertion.

Why the check exists at all
---------------------------
The scan steps run with TRIVY_SKIP_DB_UPDATE=true so the ~110 MB DB pull happens
exactly once, in a step that can retry it, instead of twice inside the scans
where a network blip reddens a security gate for no security reason. The cost of
that is that Trivy will no longer notice a stale DB itself: given a cached DB of
any age it scans against it, reports "no vulnerabilities found" and says nothing
about the age. Verified against trivy v0.70.0 with a DB backdated 20 days —
clean table, exit 0, not one warning.

A green scan from a stale DB is worse than the flake this caching replaces: it
is a gate that silently stopped covering everything disclosed since the DB was
built. So the freshness of the DB is asserted here, out loud, instead of being
assumed from a cache hit. `actions/cache` restore-keys will happily serve last
week's DB when today's key misses, so a cache hit on its own proves nothing
about age.

Where the timestamp comes from
------------------------------
Trivy writes <cache-dir>/db/metadata.json next to trivy.db, e.g.

    {"Version":2,
     "NextUpdate":"2026-08-31T07:05:29.616303372Z",
     "UpdatedAt":"2026-08-30T07:05:29.616303622Z",
     "DownloadedAt":"2026-08-30T13:04:55.459281Z"}

UpdatedAt is when upstream *built* the DB; DownloadedAt is when this runner
fetched it. Age is measured from UpdatedAt because that is the one that bounds
which CVEs the DB can possibly know about — a fresh download of an old build is
still an old build.

NextUpdate is UpdatedAt + 24h — Trivy's own refresh hint, and the bound that
used to apply here when Trivy was the one deciding. The 48h ceiling is
deliberately looser so that an ordinary same-day cache hit is not churned into
a re-download, and it is the figure prevailing-winds#315 specifies. The honest
cost of that: a scan may now run against a DB up to 48h old where Trivy left to
itself would have refreshed at 24h. What it buys is a bound that is stated,
checked and logged on every run, rather than one that is implied. Tighten it by
lowering DB_MAX_AGE_HOURS in trivy.yml; nothing else has to change.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

CACHE_DIR = os.environ.get("TRIVY_CACHE_DIR", "")
MAX_AGE_HOURS = float(os.environ.get("DB_MAX_AGE_HOURS", "48"))

# Trivy's Go timestamps carry nanoseconds; datetime.fromisoformat tops out at
# microseconds, so trim the fraction to 6 digits and spell UTC as +00:00.
_FRACTION = re.compile(r"(\.\d{6})\d+")


def fail(reason: str) -> "None":
    print(f"Trivy DB is NOT usable: {reason}", file=sys.stderr)
    sys.exit(1)


def main() -> "None":
    if not CACHE_DIR:
        fail("TRIVY_CACHE_DIR is not set, so there is no DB to check.")

    db = os.path.join(CACHE_DIR, "db", "trivy.db")
    metadata = os.path.join(CACHE_DIR, "db", "metadata.json")

    if not os.path.isfile(db):
        fail(f"{db} does not exist.")
    if not os.path.isfile(metadata):
        fail(f"{metadata} does not exist.")

    try:
        with open(metadata, encoding="utf-8") as handle:
            meta = json.load(handle)
    except (OSError, ValueError) as exc:
        fail(f"{metadata} could not be read as JSON: {exc}")

    raw = meta.get("UpdatedAt")
    if not raw:
        fail(f"{metadata} has no UpdatedAt field: {meta!r}")

    try:
        built = datetime.fromisoformat(
            _FRACTION.sub(r"\1", str(raw)).replace("Z", "+00:00")
        )
    except ValueError as exc:
        fail(f"{metadata} UpdatedAt {raw!r} is not a timestamp: {exc}")
    if built.tzinfo is None:
        built = built.replace(tzinfo=timezone.utc)

    age_hours = (datetime.now(timezone.utc) - built).total_seconds() / 3600

    # A DB built in the future means a corrupt file or a wrong clock, and either
    # way the age is not something to reason from. One hour of slack absorbs
    # ordinary skew; past that, refuse rather than treat it as very fresh.
    if age_hours < -1:
        fail(f"UpdatedAt {raw} is {-age_hours:.1f}h in the future — bad clock or corrupt metadata.")

    if age_hours > MAX_AGE_HOURS:
        fail(
            f"built {raw} = {age_hours:.1f}h old, over the {MAX_AGE_HOURS:.0f}h ceiling. "
            "It cannot know about anything disclosed since."
        )

    print(
        f"Trivy DB built {raw} ({age_hours:.1f}h old), "
        f"within the {MAX_AGE_HOURS:.0f}h ceiling."
    )


if __name__ == "__main__":
    main()
