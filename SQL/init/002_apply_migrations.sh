#!/bin/bash
# Apply everything in SQL/migrations/ after the base schema, in filename order.
#
# Why this exists: docker-compose mounts SQL/init/ into
# /docker-entrypoint-initdb.d/, so a fresh `task init` / `task db:reset` used to
# create the base schema and NOTHING else — every migration was silently skipped
# locally. That was survivable while migrations only ALTERed existing tables, but
# 003 CREATEs the print_jobs/printer_agents tables, so a local DB without it 500s
# on every /api/print request.
#
# MySQL's entrypoint only runs files directly in /docker-entrypoint-initdb.d and
# ignores subdirectories, which is why the migrations are mounted elsewhere
# (/docker-entrypoint-migrations/) and applied by this script instead of being
# mounted alongside the base schema.
#
# The numeric prefix matters: this must sort AFTER 001_TALLY_Init.sql.
#
# NOTE: this covers LOCAL dev only. Production migrations are applied by the
# Prevailing Winds migrate playbook, which selects the database with -D TALLY —
# which is why migration files must not contain a USE statement.
set -euo pipefail

MIGRATIONS_DIR=/docker-entrypoint-migrations

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[migrations] $MIGRATIONS_DIR not mounted; skipping"
  exit 0
fi

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "[migrations] none found"
  exit 0
fi

# Some migrations are already satisfied by the base schema — 002 adds an index
# that 001_TALLY_Init.sql now also creates, so on a FRESH database it fails with
# "Duplicate key name". There is no schema-version table to consult, so the only
# way to tell "already applied" from "broken" is the error code:
#   1050 table exists · 1060 duplicate column · 1061 duplicate key
#   1091 can't DROP (doesn't exist) · 1826/1022 duplicate foreign key
# Those are skipped; anything else is a genuine error and aborts, so a typo in a
# new migration still fails loudly instead of silently leaving tables missing.
ALREADY_APPLIED='ERROR (1050|1060|1061|1091|1826|1022)'

failed=0
for f in "${files[@]}"; do
  name=$(basename "$f")
  if out=$(mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" -D TALLY < "$f" 2>&1); then
    echo "[migrations] applied $name"
  elif echo "$out" | grep -qE "$ALREADY_APPLIED"; then
    echo "[migrations] skipped $name (already satisfied by the base schema)"
  else
    echo "[migrations] FAILED $name: $out" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "[migrations] one or more migrations failed" >&2
  exit 1
fi
echo "[migrations] done (${#files[@]} file(s))"
