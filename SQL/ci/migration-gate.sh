#!/usr/bin/env bash
#
# The migration gate: prove SQL/migrations/ is idempotent and schema-stable.
#
# Builds a throwaway MySQL 8.4 (prod's catalog version, and docker-compose's
# pin) from SQL/init/001_TALLY_Init.sql, applies the whole SQL/migrations/
# chain in order, then applies THE WHOLE CHAIN AGAIN and requires it to
# succeed. Finally it dumps the resulting schema and byte-compares it against
# the committed SQL/expected-schema.sql.
#
# Why: on 2026-08-15 tally prod served 500s for 14h17m. Migration 002 added
# indexes that had since been folded into the base schema, so on a database
# built from the current 001 it died with `ERROR 1061 Duplicate key name` —
# and because the migrate-all playbook stops at the first error it took 003
# down with it, leaving the print tables absent while the deploy reported
# success. Applying the chain twice is exactly the check that would have
# caught it; CLAUDE.md rule 9 is the rule, this script is its enforcement.
#
# Usage:
#   SQL/ci/migration-gate.sh            # verify (what CI runs)
#   SQL/ci/migration-gate.sh --write    # regenerate SQL/expected-schema.sql
#
# Requires: docker. Nothing else — no local MySQL, no client install. The
# mysql/mysqldump binaries used are the ones inside the 8.4 image, so the dump
# format cannot drift with whatever the runner happens to have installed.

set -euo pipefail

MYSQL_IMAGE="${MYSQL_IMAGE:-mysql:8.4}"
DB=TALLY
ROOT_PW=migration-gate
CONTAINER="tally-migration-gate-$$"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INIT_SQL="$REPO_ROOT/SQL/init/001_TALLY_Init.sql"
MIGRATIONS_DIR="$REPO_ROOT/SQL/migrations"
EXPECTED="$REPO_ROOT/SQL/expected-schema.sql"

WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1

WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# --- run a mysql client inside the container ---------------------------------
# MYSQL_PWD, not -p: -p prints a warning to stderr on every invocation, and
# this script reads stderr to decide whether a migration failed.
#
# TCP, not the unix socket, and this is not a preference. The mysql image's
# entrypoint runs a TEMPORARY server during first-time init, started with
# --skip-networking so it is reachable only over the socket. That temp server
# answers `mysqladmin ping` happily while the root password has not been set
# yet, so a socket-based readiness probe returns "ready" and the very next
# statement dies with `ERROR 1045 Access denied for user 'root'@'localhost'`.
# Observed in CI, on the run where the image had to be pulled first. Speaking
# TCP means we cannot see the temp server at all: a successful connection on
# 3306 is proof the real server is up and initialised.
TCP=(--protocol=TCP -h 127.0.0.1 -P 3306)
mysql_in() {
  docker exec -i -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" mysql "${TCP[@]}" -uroot "$@"
}
mysqldump_in() {
  docker exec -i -e MYSQL_PWD="$ROOT_PW" "$CONTAINER" mysqldump "${TCP[@]}" -uroot "$@"
}

# --- boot ---------------------------------------------------------------------
say "Starting $MYSQL_IMAGE"
docker run -d --name "$CONTAINER" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PW" \
  "$MYSQL_IMAGE" >/dev/null

# Ready means "an authenticated query over TCP succeeds", nothing weaker.
ready=0
for _ in $(seq 1 120); do
  if mysql_in -N -B -e 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: MySQL never became ready" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi
docker exec "$CONTAINER" mysql --version

# --- base schema --------------------------------------------------------------
say "Applying SQL/init/001_TALLY_Init.sql"
if ! mysql_in < "$INIT_SQL" >"$WORK/init.out" 2>"$WORK/init.err"; then
  echo "FAIL: the base schema did not apply" >&2
  cat "$WORK/init.err" >&2
  exit 1
fi

table_count() {
  mysql_in -N -B -e \
    "SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA='$DB' AND TABLE_TYPE='BASE TABLE'" 2>/dev/null
}
echo "base schema: $(table_count) tables"

# --- apply the chain ----------------------------------------------------------
# A migration fails if the mysql client exits non-zero OR writes an ERROR line
# to stderr. It does NOT fail for producing output: migration 010's no-op
# branch is `SELECT 1`, so a re-run legitimately prints result rows on stdout.
# Rows are not errors. (This is the exact distinction that made a manual
# verification of the chain look broken when it wasn't.)
apply_chain() {
  local pass="$1" f name rc
  local failed=0
  for f in "$MIGRATIONS_DIR"/*.sql; do
    name="$(basename "$f")"
    rc=0
    mysql_in -D "$DB" < "$f" >"$WORK/out" 2>"$WORK/err" || rc=$?
    if [ "$rc" -ne 0 ] || grep -q '^ERROR' "$WORK/err"; then
      echo "  FAIL  $name" >&2
      sed 's/^/        /' "$WORK/err" >&2
      failed=1
    else
      echo "  ok    $name"
    fi
  done
  if [ "$failed" -ne 0 ]; then
    cat >&2 <<EOF

FAIL: pass $pass of the migration chain did not apply cleanly.
EOF
    if [ "$pass" = 2 ]; then
      cat >&2 <<'EOF'
Pass 2 is the idempotency check. A migration that applies once and fails on a
re-run is the 2026-08-15 outage: migrate-all stops at the first error, so it
also blocks every later migration, and the deploy still reports success.
Guard the DDL with an information_schema check + prepared statement (see
SQL/migrations/002_entity_indexes.sql), or use CREATE TABLE IF NOT EXISTS.
EOF
    fi
    exit 1
  fi
}

say "Pass 1: applying the migration chain"
apply_chain 1
echo "after pass 1: $(table_count) tables"

# --- normalised schema dump ---------------------------------------------------
# Deterministic by construction: tables are named explicitly in C-collation
# order (mysqldump emits them in argument order), --compact drops the banner
# and the session-variable preamble, and the AUTO_INCREMENT counter is stripped
# because it tracks rows, not shape.
dump_schema() {
  local out="$1" tables
  tables="$(mysql_in -N -B -e \
    "SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA='$DB' AND TABLE_TYPE='BASE TABLE'" 2>/dev/null \
    | tr -d '\r' | LC_ALL=C sort)"

  {
    cat <<'HEADER'
-- SQL/expected-schema.sql — the schema SQL/init + SQL/migrations must produce.
--
-- GENERATED FILE. Do not hand-edit. Any PR that adds or changes a migration
-- must regenerate it, or the CI migration gate fails on schema drift:
--
--     SQL/ci/migration-gate.sh --write
--
-- (Needs docker; nothing else. It boots a throwaway MySQL 8.4, applies
-- SQL/init/001_TALLY_Init.sql then every SQL/migrations/*.sql in order, and
-- writes the normalised `mysqldump --no-data` of the result here.)
--
-- Normalisation, so the comparison is a stable byte diff: tables are dumped in
-- C-collation name order, mysqldump runs --compact (no banner, no dump date,
-- no session-variable preamble), and AUTO_INCREMENT counters are stripped.
--
-- This file is what catches the base schema drifting ahead of the migration
-- chain — the underlying cause of the 2026-08-15 outage, where indexes were
-- folded into 001 while 002 still added them unguarded.
HEADER
    echo
    # shellcheck disable=SC2086
    mysqldump_in --no-data --compact --skip-dump-date --skip-set-charset \
      "$DB" $tables \
      | sed -e 's/ AUTO_INCREMENT=[0-9]*//' \
            -e 's/[[:space:]]*$//' \
      | grep -v '^/\*!' \
      | cat -s
  } > "$out"
}

dump_schema "$WORK/after-pass1.sql"

# --- apply the chain a second time --------------------------------------------
say "Pass 2: applying the SAME chain again (the idempotency guarantee)"
apply_chain 2
echo "after pass 2: $(table_count) tables"

dump_schema "$WORK/after-pass2.sql"

say "Comparing the schema after pass 1 with the schema after pass 2"
if ! diff -u "$WORK/after-pass1.sql" "$WORK/after-pass2.sql"; then
  echo "FAIL: re-running the chain changed the schema. A migration is not a no-op on re-run." >&2
  exit 1
fi
echo "identical — re-running the chain is a true no-op"

# --- expected-schema comparison ------------------------------------------------
if [ "$WRITE" -eq 1 ]; then
  cp "$WORK/after-pass2.sql" "$EXPECTED"
  say "Wrote $EXPECTED"
  echo "$(table_count) tables. Commit this file with the migration that changed it."
  exit 0
fi

say "Comparing against SQL/expected-schema.sql"
if [ ! -f "$EXPECTED" ]; then
  echo "FAIL: $EXPECTED does not exist. Generate it with: SQL/ci/migration-gate.sh --write" >&2
  exit 1
fi
if ! diff -u "$EXPECTED" "$WORK/after-pass2.sql"; then
  cat >&2 <<'EOF'

FAIL: schema drift. The schema built by SQL/init + SQL/migrations no longer
matches the committed SQL/expected-schema.sql.

If the diff above is the change you intended, regenerate the file and commit it
in the same PR:

    SQL/ci/migration-gate.sh --write

If it is NOT what you intended, a migration is changing the schema in a way
nobody declared — which is how the base schema drifts ahead of the chain.
EOF
  exit 1
fi

say "PASS"
echo "chain applies clean twice, and the resulting schema matches SQL/expected-schema.sql"
