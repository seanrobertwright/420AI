# Code Review — M15 Slice 15.9: API keys + retire `ADMIN_TOKEN`

**Reviewed:** commit `48f4e28` (`feat(m15): API keys + retire ADMIN_TOKEN (slice 15.9)`)
**Against:** [`.agents/plans/m15-slice9-api-keys.md`](../plans/m15-slice9-api-keys.md) acceptance criteria
**Date:** 2026-08-01

**Stats:**

- Files Modified: 58
- Files Added: 11
- Files Deleted: 0
- New lines: 7,607
- Deleted lines: 506

---

## Verdict

**No critical, high or medium defects found.** Five LOW / informational findings below, of which
**two are recommended as documentation changes rather than behaviour changes** — changing them would
contradict a decision the slice deliberately made.

All twelve of the plan's acceptance criteria are met and independently verified (see
[Acceptance criteria](#acceptance-criteria-verification)). The security-critical paths — the role
`min`, the SSE re-check, the re-auth gate, the hash-only storage — each carry a test that fails when
the mechanism is removed, which is the property that matters here.

---

## Findings

### 1. `revokeApiKey` omits the expiry predicate its three siblings carry

```
severity: low
file: packages/db/src/repositories/api-keys.ts
line: 198
issue: An EXPIRED key is invisible to `listApiKeys` but still returns `true` from `revokeApiKey` (→ HTTP 204, not 404).
```

**detail:** Four functions define "live" and only three agree. `findLiveApiKey`, `isApiKeyLive` and
`listApiKeys` all use `isNull(revokedAt) AND (expiresAt IS NULL OR expiresAt > now)`. `revokeApiKey`
uses only `isNull(revokedAt)`. So a key that has expired is filtered out of `GET /v1/auth/api-keys`
yet `DELETE /v1/auth/api-keys/:id` on the same id answers 204 rather than the 404 a caller would
predict from the list.

**Verified, not inferred** — driven directly against the app role:

```
✓ an EXPIRED key is invisible to list but STILL deletable (204, not 404)
  listApiKeys(...)      → length 0
  revokeApiKey(...)     → true
```

**suggestion: document it; do not "fix" it.** The current behaviour is arguably the better one — a
UI holding a slightly stale list should get an idempotent 204 when the user clicks Revoke, not a
confusing 404, and stamping `revoked_at` on an already-inert key is harmless. What is missing is the
*statement* that the divergence is deliberate. Add one line to `revokeApiKey`'s doc comment, e.g.:

> Deliberately NOT filtered on expiry, unlike every other predicate in this file: revoking an
> already-expired key is harmless and idempotent, and answering 404 for a row a stale UI is still
> showing would be worse than answering 204.

Without that line the next reader will "align" the four predicates and turn a friendly 204 into a
404 regression.

---

### 2. Test scaffolding ships in the production build artifact

```
severity: low
file: apps/ingest/src/test-support/bootstrap-key.ts
line: 1
issue: `seedBootstrapKey` is inside `include: ["src/**/*"]`, so it compiles into `apps/ingest/dist/`.
```

**detail:** `apps/ingest/tsconfig.json` includes `src/**/*` with `outDir: dist`. This file is a
plain `.ts` (not `*.test.ts`), so it is in the production compilation graph. Verified — the emitted
files exist:

```
apps/ingest/dist/test-support/bootstrap-key.js
apps/ingest/dist/test-support/bootstrap-key.d.ts
apps/ingest/dist/test-support/bootstrap-key.js.map
```

The helper's job is *"seed a user and mint an owner-rung API key for any email"*. That reads badly in
a shipped server bundle — and `dist/server.js` is exactly what the desktop app spawns.

**This is artifact hygiene, not a vulnerability.** It is never imported by `server.ts`, so it never
executes; and anyone positioned to call it already holds a `Db` handle, which is strictly more power
than the function grants. But it is scaffolding in a shipped artifact and a reviewer will flag it
every time.

**suggestion:** exclude it the way the repo already excludes integration tests — add
`"exclude": ["src/**/*.int.test.ts", "src/test-support/**"]` to `apps/ingest/tsconfig.json`. vitest
type-strips via esbuild and does not consult that exclude, so every converted suite keeps working.
Cheaper alternative if you would rather not touch tsconfig: rename to `bootstrap-key.test-support.ts`
only if an exclude pattern already matches it — otherwise the tsconfig edit is the honest fix.

---

### 3. `app.apiKeyLastTouchedAt` is never evicted

```
severity: low
file: apps/ingest/src/app.ts
line: 175
issue: The throttle Map grows one entry per distinct API key ever presented, and entries are never removed.
```

**detail:** Keyed by `api_keys.id`. A revoked key's entry persists for the process lifetime. It is
**not** attacker-growable — `shouldTouchApiKey` is only reached after `findLiveApiKey` returns a row,
so an unknown token adds nothing — which is the property that keeps this LOW rather than a DoS.
Bounded in practice by the number of live keys a deployment has ever used since boot (tens).

It also mirrors `reconcileLastRunAt`, which has the same unbounded shape and has been in the codebase
since 15.4, so this is consistent rather than novel.

**suggestion:** no change now. If a third such map appears, that is the signal to introduce one
small bounded-LRU helper rather than a third bespoke `Map`. Worth one sentence in the decorator's
doc comment noting the bound is "live keys, not requests", so nobody has to re-derive that.

---

### 4. A stolen low-rung key can revoke its owner's higher-rung keys

```
severity: low (accepted design consequence — document, do not change)
file: apps/ingest/src/routes/api-keys.ts
line: 152
issue: List and revoke are gated at `viewer` and scoped by `principal.userId`, so any of a user's keys can revoke any other.
```

**detail:** A leaked `viewer`-rung key can call `GET /v1/auth/api-keys` (enumerating its owner's key
ids, names and timestamps — no secrets) and then `DELETE /v1/auth/api-keys/:id` on **any** of them,
including an `admin`-rung key and the one the desktop app depends on. It cannot escalate; it can
destroy.

This is **deliberate and inherited**, not an oversight: it is exactly the shape 15.6 chose for
sessions ("managing YOUR OWN sessions is not a privileged act... a read-only account must still be
able to sign out a stolen laptop"), and this slice's own rule — *revocation must never be harder than
minting* — requires it. Gating revoke behind re-auth would put a password prompt in the middle of an
incident response.

The asymmetry it creates is real though: **minting needs re-auth, revoking does not**, so a stolen
key is powerless to create and fully able to destroy.

**suggestion:** state the consequence once, where an operator will meet it — one row in
`docs/guide/operations.md` §15.9's troubleshooting table, e.g. *"All my keys were revoked and I
didn't do it → any key can revoke its owner's other keys by design (revocation is never gated). Treat
a leaked key as a DoS on your other keys, not just a read risk; re-mint and reduce the leaked key's
rung."* No code change.

---

### 5. No per-user key cap and no `(user_id, name)` uniqueness

```
severity: informational
file: packages/db/src/schema.ts
line: 356
issue: A user may mint unbounded keys, and any number of them may share a name.
```

**detail:** Minting requires a valid session **and** the current password, and is rate-limited by
`app.rateLimitLogin` where configured, so this is not a realistic abuse vector. Duplicate names are a
UX wrinkle (the list disambiguates by `createdAt` / `lastUsedAt`), not a correctness issue.
`sessions` is likewise uncapped — every login mints one — so this is consistent with precedent.

**suggestion:** none for this slice. If 15.10's management UI surfaces "you have 47 keys", revisit
then; a cap added now would be a guess at the right number.

---

## What was checked and found correct

These are the places a defect would have been most costly, each confirmed by reading the code and by
a test that fails when the mechanism is removed:

- **The role `min` (D-15.9-4).** `effectiveApiKeyRole` is pure and exported; the full 4×4 matrix is
  asserted against an independently-computed expectation (`ROLES.indexOf`) that shares no code with
  `hasRole`, so a ladder bug cannot cancel itself out. `null` → inherit; a non-`ROLES` string →
  **reject, not clamp**; a corrupt *membership* role delegates to `authorized()` rather than being
  re-decided here.
- **The SSE re-check (the slice's stated top risk).** `keyId` is captured **before** `reply.hijack()`
  alongside `sid`; the probe uses `isApiKeyLive` (no `last_used_at` write), and `inFlight` is reset
  in a `finally`, so the early `return terminate(...)` cannot wedge the stream. Mutation-proven:
  deleting the probe fails exactly one test.
- **Prefix routing.** `startsWith`, never a split. No collision is possible with the other tier — a
  session token is `base64url(JSON)` and always begins `ey`. Asserted.
- **Hash-only storage.** The plaintext is checked absent from the **whole row cast to text**, not
  from a hand-listed set of columns, so a future column that captured it would be caught.
- **Fire-and-forget touch.** `void …catch(() => {})` — the `.catch` is present, so a detached
  rejection cannot take the process down.
- **`decorateRequest("apiKeyId", null)`** — primitive default, per Fastify's shared-reference rule.
- **Member removal** revokes sessions and keys inside the same `withOrg` transaction, both under the
  `if (removed)` guard.
- **The `ADMIN_TOKEN` retirement is complete**, not partial: `grep -rn "adminToken" apps/ingest/src
  packages/*/src` returns 0 hits, and a test asserts the retired literals now 401 — the build alone
  would not have proven this (deleting a symbol makes `tsc` a file-level checklist).
- **The 24-file conversion has no ordering bug** — no converted suite reads `ADMIN`/`SERVICE_TOKEN`
  inside a `beforeAll` that runs before the mint. Checked mechanically across every converted file.
- **`fileParallelism: false`** means the `beforeAll`-minted key in `observability.int.test.ts` (the
  one suite with no `TRUNCATE`) cannot be wiped by a sibling suite mid-file.

---

## Acceptance criteria verification

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Mint / list / use / revoke by owner | ✅ end-to-end test |
| 2 | Plaintext returned exactly once, in no response and no column | ✅ asserted against raw body + full-row text |
| 3 | Cannot mint above minter's rung (403); acts at the **lower** rung | ✅ ceiling + demote-after-mint tests |
| 4 | Minting requires re-auth; listing/revoking do not | ✅ both directions asserted |
| 5 | Revoked key 401s, incl. terminating an open SSE stream within one tick | ✅ mutation-proven |
| 6 | Member removal revokes keys; password change does not | ✅ both asserted, incl. the row-level stamp |
| 7 | No RLS policy; in `NO_RLS_TABLES`; "17 tenant tables" unchanged | ✅ verified live (`relrowsecurity=false`, 0 policies) |
| 8 | Desktop + `generate-reports.mjs` authenticate with an API key | ✅ |
| 9 | `ADMIN_TOKEN` authenticates nothing; grep returns 0 | ✅ |
| 10 | `.env.example` + `operations.md` document retirement, issuance and DB break-glass | ✅ new §15.9 |
| 11 | `repo-health --require-db` green, 0 skipped; `cargo test` green | ✅ 1250 tests / 472 int / 0 skipped; 28/28 |
| 12 | `SUMMARY.md` flips 15.9 to ✅ in both blocks | ✅ (PR number still `#NN`) |

---

## Notes for the record

- **The plan's `API_KEY || ADMIN_TOKEN` fallback was deliberately not shipped**, and the deviation is
  sound: it was correct for a Phase-B-only landing, but with Phase C in the same change the server
  rejects `ADMIN_TOKEN`, so the fallback would convert a fixable configuration error into an opaque
  401 on an unwatched cron job. Both consumers name the migration in their error instead. The
  `||`-not-`??` rule is still correctly applied to the `API_KEY` read itself.
- **Two environment hazards hit during execution**, neither a code defect but both worth recording:
  OneDrive deleted three tracked files mid-run and left a `-Living-Room` conflict copy (caught by
  `git status`, restored from HEAD); and Python-based edits introduced CRLF into an LF repo, which
  broke one vitest parse until all 34 affected files were normalized. `format:check` is clean.
- **Three untracked paths were deliberately excluded from the commit** — `.agents/outline.md`,
  `.agents/research-analysis-plan.md` and `.claude/` — none of which belong to this slice.
