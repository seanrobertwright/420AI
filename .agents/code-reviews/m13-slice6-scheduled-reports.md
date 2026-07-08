# Code Review — M13 Slice 13.6 (Scheduled reports + guided onboarding)

Branch: `m13-slice6-scheduled-reports` · Reviewed: 2026-07-08

**Stats:**

- Files Modified: 4 (`apps/dashboard/src/components/live-monitor.tsx`, `docs/guide/operations.md`, `package.json`, `vitest.config.ts`)
- Files Added: 6 (`scripts/generate-reports.mjs`, `scripts/generate-reports.test.ts`, `scripts/setup-env.mjs`, `scripts/setup-env.test.ts`, `apps/dashboard/src/components/monitor/onboarding-card.tsx`, `docs/guide/quickstart.md`)
- Files Deleted: 0
- New lines: ~587 (545 new-file + 42 modified insertions)
- Deleted lines: 2

## Scope

Slice 13.6 adds two OS-cron scripts (report generation + `.env` setup), their unit tests, an
operations runbook section, a quickstart guide, and a first-run onboarding empty state on the Live
Monitor. No `@420ai/db` / `apps/ingest` source changed; the scripts are HTTP clients of existing
admin endpoints.

## Verification performed

- `npm run repo-health` → PASS (root + dashboard + desktop typecheck 0 errors; 711 unit tests).
- `npm run repo-health -- --require-db` → PASS (183 integration tests ran, **0 skipped**).
- `npm run build:dashboard` → PASS (`/monitor` compiles with the new onboarding branch).
- New unit tests: 16 passing (`scripts/setup-env.test.ts`, `scripts/generate-reports.test.ts`).
- Live end-to-end: `setup-env.mjs` against the real `.env.example` in a temp dir → all four
  server-required keys filled (base64 32B = 44 chars; base64url 32B = 43 chars), dashboard
  `.env.local` SESSION_SECRET matches, re-run refuses (exit 1). `generate-reports.mjs` CLI error
  paths (missing env / unknown type / unknown flag) all exit 1 with clean messages, no stack traces.
- `npx prettier --check` on all touched files → clean.

## Findings

### Logic / correctness

- **`fillKey` anchored replace (setup-env.mjs:44):** `^KEY=.*$` with the `m` flag + no `g` matches
  the FIRST whole-line assignment only. Verified against the real `.env.example` that
  `ARCHIVE_ENCRYPTION_KEY=` is filled while the longer siblings `ARCHIVE_ENCRYPTION_KEYS=` /
  `ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID=` and the `#`-prefixed example comments are untouched.
  Covered by the sibling-key test. ✔
- **Regex-replacement metachar safety (setup-env.mjs:44):** the replacement is a **function**
  (`() => \`${key}=${value}\``), so a `$` in a generated secret is inserted literally rather than
  interpreted as `$&`/`$1`. base64url never emits `$`, but the function form is correct regardless;
  covered by an explicit `ab$1$&cd` test. ✔
- **`generate-reports.mjs` project shape:** `body.projects.map(p => p.id)` matches the verified
  `GET /v1/projects` → `{ projects: [...] }` contract (routes/projects.ts:49). `--project <uuid>`
  bypasses the list and POSTs directly; a bad id 404s server-side → counted as a failure, exit 1. ✔
- **Timeout discipline:** every `fetch` is bounded by `AbortSignal.timeout(30_000)` (CLAUDE.md
  outbound-HTTP rule). Abort-cancellability is a daemon concern; this is a short-lived cron script,
  so timeout alone is sufficient. ✔
- **Process boundaries:** both scripts keep pure/testable helpers separate from a single
  `import.meta.url === argv[1]` entrypoint that owns all I/O + stdout + exit (CLAUDE.md
  library/entrypoint rule). ✔

### Security

- No secrets logged or committed. `setup-env.mjs` writes `.env` + `apps/dashboard/.env.local` with
  `mode 0o600` and refuses to overwrite an existing `.env` (the A.1 footgun). The dashboard file
  carries only `INGEST_URL` + `SESSION_SECRET` (no `NEXT_PUBLIC_*`), matching the D8 rule. `ADMIN_TOKEN`
  is read from env by `generate-reports.mjs`, never hard-coded. No injection surface (no SQL, no shell).

### Dashboard

- **`live-monitor.tsx`:** the zero-machines branch renders `<OnboardingCard/>` in place of the full
  `<MonitorView/>`. Note: this also hides `AlertsPanel` on a fresh install. `AlertsPanel` renders
  only "No active alerts." when empty, and on a genuinely fresh install (no machine paired, nothing
  ingested) firings are empty — so nothing meaningful is hidden. Matches the plan's "instead of the
  empty tables" directive; accepted as designed. ✔
- **`onboarding-card.tsx`:** pure/presentational, no data or token; JSX entities escaped
  (`&apos;`/`&lt;`/`&gt;`); reuses existing `Card` primitives + `cn`. ✔

### Docs

- The `operations.md#136--scheduled-reports-opt-in` cross-link in `quickstart.md` resolves to the
  new heading `## 13.6 — Scheduled reports (opt-in)` under GitHub's anchor algorithm. ✔

## Verdict

**Code review passed. No technical issues detected.** All validation gates green including the
DB-backed integration layer (0 skipped).
