#!/bin/sh
# M14 pre-sign-off (checklist item 2) — NON-DESTRUCTIVE restore drill.
# Usage:  sh scripts/restore-drill.sh <backup.sql.gz> [scratch_db_name]
#
# Restores a backup produced by backup-archive.sh into a THROWAWAY database (default: "scratch")
# and prints row counts, so the restore path is verified WITHOUT touching the live 420ai archive.
# Re-runnable: it drops+recreates the scratch DB each time. Runs entirely inside the compose
# `archive` container (no host psql/gunzip required; -T disables TTY for the pipe).
set -eu

[ $# -ge 1 ] || { echo "usage: sh scripts/restore-drill.sh <backup.sql.gz> [scratch_db_name]" >&2; exit 1; }
SRC="$1"
SCRATCH="${2:-scratch}"
[ -f "$SRC" ] || { echo "no such backup file: $SRC" >&2; exit 1; }

# Never let a typo point the drill at the live DB.
case "$SCRATCH" in
  420ai) echo "refusing to drill into the live '420ai' DB — pass a scratch name" >&2; exit 1 ;;
esac

# Verify gzip integrity BEFORE streaming into psql (a truncated archive otherwise half-applies).
gunzip -t "$SRC" || { echo "corrupt gzip, aborting drill: $SRC" >&2; exit 1; }

echo "== restore drill =="
echo "backup:     $SRC"
echo "scratch db: $SCRATCH (live '420ai' is untouched)"

# Fresh scratch DB every run so the drill is idempotent.
docker compose exec -T archive psql -U 420ai -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $SCRATCH;" -c "CREATE DATABASE $SCRATCH;"

# Restore the plain SQL dump into the scratch DB.
gunzip -c "$SRC" | docker compose exec -T archive psql -U 420ai -d "$SCRATCH" >/dev/null

echo "== row counts in '$SCRATCH' =="
docker compose exec -T archive psql -U 420ai -d "$SCRATCH" -At -c \
  "select 'raw_source_records', count(*) from raw_source_records
   union all select 'events', count(*) from events
   union all select 'projects', count(*) from projects;"

echo "== drill complete =="
echo "the scratch DB '$SCRATCH' is left in place for inspection; drop it with:"
echo "  docker compose exec -T archive psql -U 420ai -c 'DROP DATABASE IF EXISTS $SCRATCH;'"
