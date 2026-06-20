#!/bin/sh
# M12 12.4d — timestamped, gzipped pg_dump of the archive + backup-file retention prune.
# Usage:  BACKUP_DIR=./backups RETENTION_DAYS=14 sh scripts/backup-archive.sh
#
# Runs pg_dump INSIDE the compose container (the postgres:17 image ships pg_dump), so no host
# Postgres client is required. Plain SQL + gzip = portable + greppable. Schedule it via OS cron
# / Windows Task Scheduler (see docs/guide/operations.md) — NO in-server scheduler is added.
set -eu

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/420ai-$STAMP.sql.gz"
TMP="$OUT.tmp"
# Always clean the uncompressed temp, whether we succeed or bail.
trap 'rm -f "$TMP"' EXIT INT TERM

# Raw records are immutable + sacred (PRD §8.5) → a full logical dump is the source of truth.
# -T disables TTY allocation so this works under cron / non-interactive shells. We dump to a
# TEMP file first (NOT `pg_dump | gzip`): under POSIX sh `set -e` only checks the LAST command
# in a pipeline, so a failing pg_dump piped into a succeeding gzip would write a silently-empty
# .gz and exit 0. Dumping first makes `set -e` abort on a bad dump, so $OUT is never created.
docker compose exec -T archive pg_dump -U 420ai -d 420ai > "$TMP"
gzip -c "$TMP" > "$OUT"
echo "wrote $OUT"

# Retention: prune BACKUP FILES older than RETENTION_DAYS (not DB rows — raw stays forever).
# Scoped glob so only this script's own dumps are ever deleted.
find "$BACKUP_DIR" -name '420ai-*.sql.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete
