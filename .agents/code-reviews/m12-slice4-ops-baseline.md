# Code Review — M12 Slice 12.4 Operations Baseline

**Stats:**

- Files Modified: 14
- Files Added: 24 (8 src + 3 tests + 10 down-SQL + 2 shell + 1 doc) excluding the plan file
- Files Deleted: 0
- New lines: ~267 on tracked files + ~700 in new files
- Deleted lines: ~26

Reviewed against CLAUDE.md conventions (process boundaries, inject-clocks, additive opts,
"raw sacred", the Drizzle/SQL gotchas) and the existing codebase patterns. Full gate
(`repo-health --require-db`) passes: 506 tests, 136 int tests, 0 skipped.

---

## Issues found

```
severity: medium
file: scripts/backup-archive.sh
line: 23
issue: pg_dump failure is silently masked by the gzip pipe → a bad/empty backup looks successful
detail: `docker compose exec ... pg_dump | gzip > "$OUT"` runs under POSIX `sh`, where `set -e`
        only inspects the LAST command in a pipeline (gzip). If pg_dump fails (DB down, auth
        error) but gzip exits 0, the script writes a tiny valid .gz of empty input, prints
        "wrote $OUT", and exits 0 — a silently corrupt backup, which is the worst failure mode
        for a backup tool. POSIX sh has no portable `pipefail`.
suggestion: Dump to a temp file first (so `set -e` catches pg_dump's exit), then gzip it; clean
        the temp via an EXIT trap. No .gz is produced when the dump fails.
```

```
severity: medium
file: packages/db/src/crypto.ts
line: 41
issue: keyId is not validated → a keyId containing "." silently corrupts decryption, and one
        containing "%" or "_" silently breaks the rotation filter
detail: decryptField splits the keyId on the FIRST "." (`indexOf(".")`). A keyId like "v.2"
        would be parsed as id="v" → wrong key → decrypt failure. Separately, key-rotation.ts
        filters un-rotated rows with `payload_ciphertext NOT LIKE '<activeId>.%'`; if activeId
        contains a LIKE wildcard ("%" or "_") the filter matches the wrong rows and silently
        skips (or double-processes) ciphertext. Both are operator-config foot-guns that fail
        silently — exactly the class that loses data during a key rotation.
suggestion: Validate each keyId against `^[A-Za-z0-9-]+$` when building the keyring (rejects
        ".", "%", "_", and whitespace). Cheap, and turns a silent-corruption path into a clear
        boot-time error.
```

```
severity: low
file: apps/ingest/src/server.ts
line: 70
issue: an empty-string RATE_LIMIT_WINDOW / RATE_LIMIT_LOGIN_WINDOW env passes "" through ?? to
        @fastify/rate-limit
detail: `process.env.RATE_LIMIT_WINDOW ?? "1 minute"` only falls back on undefined, not "". An
        operator who sets `RATE_LIMIT_WINDOW=` (empty) would pass "" as the timeWindow, which the
        plugin can't parse. Mirrors the existing `ANALYSIS_BASE_URL || undefined` pattern, which
        already uses `||` to treat empty as unset.
suggestion: Use `||` for the two window strings so empty falls back to the default.
```

```
severity: low
file: scripts/restore-archive.sh
line: 14
issue: a corrupt .gz is only detected mid-restore (by psql), after partial SQL may have applied
detail: `gunzip -c "$SRC" | psql` streams; if the gzip is truncated, psql may have already run
        some statements before the stream breaks. A pre-flight integrity check is cheap.
suggestion: `gunzip -t "$SRC"` before the pipe so a corrupt archive aborts before touching the DB.
```

---

## Verified correct (no change needed)

- **Rate-limit per-route wiring** (`app.ts` / `routes/auth.ts`): `app.decorate("rateLimitLogin")`
  runs synchronously before `app.register(authRoutes)` defers route definition to `ready()`, so
  `config.rateLimit` always resolves. Proven live by `observability.int.test.ts` (429 on the 3rd
  login). `global:false` keeps the ingest hot path unthrottled.
- **Keyring back-compat**: legacy single-key mode emits un-prefixed base64 + the same two error
  strings → existing `crypto.test.ts` passes unchanged (8/8). Base64 has no ".", so the prefix
  split is unambiguous for the documented keyId charset.
- **`reencryptAll`**: per-table transaction is atomic (no partial rotation); the `NOT LIKE
  '<active>.%'` + isNotNull WHERE means re-encrypted rows aren't re-selected → terminates; the
  legacy-mode guard throws instead of a silent no-op. Idempotent (2nd run = all-zero counts).
- **`rollback.ts`**: uses the real `drizzle.__drizzle_migrations` shape (Spike B); `created_at`
  bigint → Number(); down SQL split on the same `--> statement-breakpoint` marker; wrapped in a
  tx with rollback-on-error; deletes the tracking row by `created_at`. Round-trip proven by
  `rollback.int.test.ts` (rollback 0009 → re-migrate restores it).
- **Down-migrations**: drop order is FK-safe (corrected 0004 vs the plan's example — both child
  tables before `git_commits`); index-on-pre-existing-table (`events_by_project_path` in 0001)
  gets an explicit DROP INDEX; column-adds reverse with DROP COLUMN.
- **Logging redaction**: `redact:{paths:["req.headers.authorization","req.headers.cookie"],
  remove:true}` strips the bearer/cookie from every log line.
- **Process boundaries**: backup/restore/rotate-key/rollback are entrypoint scripts (log/argv/
  exit only at entrypoints); metrics is an in-memory counter + an `onResponse` hook — no timer,
  no long-lived resource (M9 leak discipline holds).
- **Secrets**: `backups/` gitignored; no NEXT_PUBLIC_* token; metrics admin-gated.
