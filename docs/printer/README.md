# Printer scripts live in the `tally-printer` repo

`pdf2tspl.py` used to be vendored here as a runnable copy. It has been removed
on purpose: it drifted, and the stale copy still emitted **`GAP 0,0`**.

That is not a cosmetic difference. `GAP 0,0` tells the printer the roll is
continuous, so it never registers on the die-cut gaps: every label creeps by
the gap distance until the print walks across the perforation. Chasing that
bug — and the blank-feed / red-light failure that follows once a real gap *is*
requested but the sensor has never been calibrated — cost a full debugging
session on 2026-08-06.

**Source of truth:** `tally-printer/agent/pdf2tspl.py` (deployed to the Pi at
`/opt/tally-printer`).

- Label geometry lives in `SIZES`, whose entries are `(width_in, height_in,
  gap_in)` — the gap travels with the preset, so changing stock in tally sends
  the right value automatically.
- Calibration, the TSPL commands this printer actually implements, and the
  no-feed-button quirks of this unit are documented in
  `tally-printer/docs/CALIBRATION.md`.

If you need the script on a machine, take it from that repo rather than from a
copy pasted into docs.
