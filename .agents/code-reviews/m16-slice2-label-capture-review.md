# Code review — M16 slice 16.2 (label capture + review)

Reviewed at commit `e8e3258`, against the acceptance criteria in
`.agents/plans/m16-slice2-label-capture-review.md`.

**Stats:**

- Files Modified: 19
- Files Added: 15 (incl. the slice plan)
- Files Deleted: 0
- New lines: 4328
- Deleted lines: 17

**Method note.** Findings 1 and 2 were **measured against the live test database** with a throwaway
int test (`spike-null-optionals.int.test.ts`, deleted after), not inferred from reading the schema.
That matters here: the schema alone suggests a `null` optional would be a type error, and the actual
mechanism is ajv **coercing** `null` → `""` and then failing `minLength`/`enum` — a different error
with the same outcome, and one that reading the JSON Schema does not predict.

---

## Findings

```
severity: critical
file: apps/desktop/src/components/LabelQueue.tsx
line: 168
issue: Submitting a label with the optional fields blank is a 400 — the slice's primary path is broken
detail: `submit()` sends `followUpCommitOrPr: draft.followUpCommitOrPr.trim() || null` and
  `confidence: draft.confidence || null`. `createOutcomeLabelBodySchema` (schemas.ts:714-715)
  declares BOTH as `type: "string"` with no null member — unlike `patchOutcomeLabelBodySchema`,
  which does allow `["string","null"]`. Fastify's default ajv runs `coerceTypes`, so `null`
  becomes `""`, which then fails `minLength: 1` (follow-up) and the `enum` (confidence).
  MEASURED: `POST` with both null → `400 {"error":"body/followUpCommitOrPr must NOT have fewer
  than 1 characters"}`; with only `confidence: null` → `400 {"error":"body/confidence must be
  equal to one of the allowed values"}`; with both keys OMITTED → `201`.
  This is the default case, not an edge case: both fields are marked optional in the UI, and a
  15-second label will usually leave them blank. The panel renders the raw rejection, so the
  operator sees an ajv message and cannot proceed — i.e. the surface this slice exists to build
  does not work for its most common input.
suggestion: On the POST path, OMIT the keys rather than sending null. The route already reads
  `body.followUpCommitOrPr ?? null` (routes/outcome-labels.ts:167-168), so absent is the correct
  wire spelling of "not stated". Build the body conditionally. Do NOT widen the POST schema to
  accept null — the PATCH/POST asymmetry is deliberate (a POST has no prior value to clear,
  so null and absent would mean the same thing, and one spelling is better than two).
```

```
severity: critical
file: apps/dashboard/src/components/projects/session-label-actions.tsx
line: 134
issue: Same 400 — `create()` spreads a `LabelFormValues` whose optional fields are null
detail: `const body = values === null ? { status: "skipped" } : { status: "labeled", ...values }`.
  `LabelFormValues` types `followUpCommitOrPr` and `confidence` as `string | null`, and
  `LabelForm` sets them to `null` whenever the input is empty (`label-form.tsx:191, 208`). Same
  root cause and same measured result as finding 1. The sibling `update()` path is NOT affected
  because it uses PATCH, whose schema does allow null — which is exactly why this slipped
  through: the edit path works, so the surface looks functional right up until a NEW label is
  saved with a blank follow-up link.
suggestion: Strip null-valued optional keys before the POST. Cleanest is a shared helper next to
  `LabelFormValues` (e.g. `toCreateBody(values)`) used by both dashboard call sites, so the
  POST/PATCH distinction lives in one place rather than being re-remembered per surface.
```

```
severity: medium
file: apps/dashboard/src/components/projects/session-label-actions.tsx
line: 122
issue: The effect's `cancelled` guard does not cover the fallback path
detail: The effect arms `let cancelled = false` before the first await (correct, and what the
  file's own header claims), but the fallback branch calls `void load()`, and `load()` performs
  its own `fetch` and calls `setLabel(...)` with no reference to `cancelled`. Navigating away
  from a project page while the per-row fallback is in flight therefore sets state on an
  unmounted island. React 18 no longer warns about this, which makes it quieter rather than
  less real — and this is the precise leak-window class CLAUDE.md names, in a file whose comment
  asserts the guard is in place. The comment being wrong is the worse half (the M15 15.5 lesson).
suggestion: Thread the guard: have `load()` take an `isCancelled: () => boolean` (or return the
  row and let the effect do the `setLabel`), so one guard covers both paths. Then the header
  comment is true again.
```

```
severity: medium
file: apps/desktop/src/components/LabelQueue.tsx
line: 232
issue: The queue count silently caps at 25 and reads as complete
detail: `GET /v1/labels/queue` defaults to `DEFAULT_QUEUE_LIMIT = 25` and the panel passes no
  limit, so with 60 settled sessions the header renders "Sessions to label (25)" — a number the
  operator will read as the total. Labeling all 25 then reveals more, which is a confusing
  ordering rather than a broken one. CLAUDE.md's "no silent caps" rule applies: a bounded view
  should say what it bounded.
suggestion: Render "(25+)" when `queue.length === DEFAULT_QUEUE_LIMIT`, mirroring the dashboard's
  own `rows.length === 200 ? "+" : ""` treatment in `labels-view.tsx:298`. Cheapest honest fix;
  no endpoint change.
```

```
severity: medium
file: apps/desktop/src/components/LabelQueue.tsx
line: 170
issue: `as never` casts defeat the type system exactly where the closed sets matter
detail: `taskType: draft.taskType as never`, and the same for `outcome` and `primaryFriction`.
  `draft` holds plain `string`s while the bridge expects the shared unions, and `as never`
  silences that rather than resolving it. The cost is specific: if a member is ever added to
  `TASK_TYPES`, or one of these strings is misspelled in this file, nothing fails to compile —
  in a slice whose stated design is "build the dropdowns from the shared arrays, never re-type
  the strings". The `Record<string, string>` copy maps in the same file have the same weakness
  (the dashboard's equivalents are keyed on the union and are unit-tested for exhaustiveness).
suggestion: Type `Draft` with the shared unions plus `""` (e.g. `taskType: TaskType | ""`), which
  removes every cast and makes the `complete` check narrow the type naturally.
```

```
severity: low
file: apps/dashboard/src/components/projects/session-label-actions.tsx
line: 55
issue: A failed shared fetch is cached for 30 s, converting one failure into N per-row requests
detail: `loadLabelIndex()` stores the promise before awaiting and keeps it for `LABEL_INDEX_TTL_MS`
  regardless of outcome, so a null result (any non-ok response) is cached. Every row then takes
  the single-session fallback — i.e. the one thing the cache exists to avoid, during exactly the
  degraded conditions when the extra load is least welcome. Self-heals after 30 s.
suggestion: Do not cache a null: clear `labelIndexPromise` in the failure branch so the next
  mount retries the batched read once, rather than N rows each issuing their own.
```

```
severity: low
file: apps/dashboard/src/lib/label-display.test.ts
line: 79
issue: An assertion computes its own expected value via string surgery
detail: `expect(qualityStars(3)).toBe("★★☆☆☆".replace("★☆", "★★"))`. It is correct
  ("★★★☆☆"), but a test whose expectation is derived rather than written is one the reader must
  execute mentally, and it would silently follow the implementation if `qualityStars` changed.
suggestion: Write the literal: `expect(qualityStars(3)).toBe("★★★☆☆")`.
```

---

## Checked and found correct

Recorded so the next reviewer does not re-derive them:

- **The queue's join-side `orgId` predicate** — re-verified during execution by deleting it and
  re-running the suite: exactly one test failed (the cross-org control, on the owner handle). The
  `where`-vs-`join` placement is correct; a `where` on the nullable side would inner-join and drop
  every unlabeled session.
- **`toIso` normalization** is present on both aggregate timestamps and asserted at both layers.
- **Route gating** — the queue handler is `viewer`-gated and wrapped in `withOrg(..., principal.role,
  ...)`, not `SERVICE_ROLE`. Correct per the 15.4 "whose action is this?" test: opening the panel is
  the caller's own act, and the queue performs no bookkeeping write.
- **No token reaches a browser or webview.** The dashboard uses same-origin proxy handlers; Rust
  holds the API key and returns opaque JSON. `grep ADMIN_TOKEN proxy.rs` → 4 hits, all comment or
  message text, 0 live uses.
- **`encode_segment`** encodes per byte, so multi-byte UTF-8 is handled correctly; unit-tested for
  `/`, `?`, `#`, space and `é`.
- **D-16.2-5's type-level exclusion** genuinely holds: `intent`/`followUpCommitOrPr`/`projectPath`
  are `never`, so the privacy test needs a cast to even express the leak it asserts against.
- **No schema change, no migration**, and the fingerprint is untouched.

## Not verified by this review

The **rendered UI** — the desktop panel, the `/labels` table, and D-16.2-3's "never raised a window"
behaviour — has not been exercised. Findings 1 and 2 are precisely the class an automated suite
missed and a single manual submit would have caught in five seconds, which is worth noting against
the plan's Level-4 round-trip being deferred.
