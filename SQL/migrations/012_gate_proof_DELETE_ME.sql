-- TEMPORARY — DELIBERATELY NON-IDEMPOTENT. Removed in the next commit.
--
-- Proves the CI migration gate actually fails. A bare CREATE INDEX with no
-- information_schema guard: applies once, then dies with ERROR 1061 on the
-- second pass. That is the 2026-08-15 shape exactly.
CREATE INDEX idx_gate_proof ON items (NAME);
