#!/bin/sh
# M12 12.4d — restore a gzipped pg_dump produced by backup-archive.sh.
# Usage:  sh scripts/restore-archive.sh <backup.sql.gz>
#
# DESTRUCTIVE on a populated DB (the dump's statements run against the live archive). Prefer
# restoring into a SCRATCH database first to verify (see docs/guide/operations.md). Pipes the
# decompressed SQL into psql inside the compose container (-T disables TTY for the pipe).
set -eu

[ $# -eq 1 ] || { echo "usage: sh scripts/restore-archive.sh <backup.sql.gz>" >&2; exit 1; }
SRC="$1"
[ -f "$SRC" ] || { echo "no such backup file: $SRC" >&2; exit 1; }

# Verify gzip integrity BEFORE streaming into psql — a truncated archive otherwise applies a
# partial restore before psql sees the broken stream.
gunzip -t "$SRC" || { echo "corrupt gzip, aborting restore: $SRC" >&2; exit 1; }

gunzip -c "$SRC" | docker compose exec -T archive psql -U 420ai -d 420ai
echo "restored from $SRC"
