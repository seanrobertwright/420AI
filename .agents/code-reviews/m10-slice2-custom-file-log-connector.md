# Code Review — M10 Slice 2: Config-only Custom File/Log Connector

Commit `659bbe2` on `m10-slice2-custom-file-log-connector`. Reviewed against `HEAD~1`.

**Stats:**

- Files Modified: 6 (`README.md`, `apps/collector/src/cli.ts`, `apps/collector/src/serve.ts`,
  `apps/collector/src/serve.test.ts`, `packages/shared/src/control-protocol.ts`,
  `packages/shared/src/control-protocol.test.ts`)
- Files Added: 5 (`apps/collector/src/connectors/custom-connector.ts` + `.test.ts`,
  `apps/collector/src/connectors/registry.ts` + `.test.ts`, `docs/guide/custom-connectors.md`)
- Files Deleted: 0
- New lines: 1010
- Deleted lines: 9

Verified the one true correctness pillar first: `readGrownPrefix` (`watcher/tailer.ts:40,56`) reads the
**whole file from byte 0** every tick and returns the whole-file prefix (`fromOffset` is used only to
detect growth/reset), so the `${sessionId}:${i}` rawId is stable across ticks. That claim in the plan
holds. The findings below are about edges the tests do not exercise.

---

## Findings

```
severity: high
file: apps/collector/src/connectors/registry.ts
line: 38
issue: loadRegistry throws on a null/non-object entry in connectors[], breaking D4 tolerance and crashing capture at boot.
detail: When validateCustomDef rejects an entry, the drop-reason builds the id via
        `(raw as { id?: unknown }).id`. This is only a TS cast; at runtime, if the JSON array
        contains `null` (or any non-object) — e.g. `{"connectors":[null]}` — `null.id` throws
        `TypeError: Cannot read properties of null (reading 'id')`. loadRegistry is called
        synchronously inside runServe() init and runWatch(), with no try/catch, so a single
        malformed-but-parseable line in ~/.420ai/custom-connectors.json takes down the collector
        for ALL connectors. This directly violates D4 ("a misconfiguration never takes down capture
        of the built-in connectors") — the load-bearing invariant the whole slice is designed around.
        VERIFIED live: a config of `{connectors:[null,5,"x"]}` throws instead of returning the builtins.
suggestion: Guard the id extraction against non-objects:
        const id =
          raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
            ? (raw as { id: string }).id
            : "(unknown)";
        Add a registry.test.ts case: `saveCustomConnectors` can't write a null, so write the raw JSON
        with writeFileSync (e.g. `{"version":"m10-custom-v1","connectors":[null,42]}`) and assert
        loadRegistry returns exactly the builtins with two dropped entries (id "(unknown)"), never throws.
```

```
severity: medium
file: apps/collector/src/connectors/custom-connector.ts
line: 250
issue: Cross-file rawId/fingerprint collision for multi-file globs without a unique sessionId → silent under-capture.
detail: rawId = `${sessionId}:${i}` does not encode the file path (Connector.parse(fileText) never
        receives it). For a perfectly valid config — `watchGlobs:["C:/logs/*.log"]` with no
        sessionIdField (so sessionId is always "unknown-session"), or a sessionId not unique per
        file — line 0 of file A and line 0 of file B both yield rawId "unknown-session:0" and the
        SAME fingerprint. Because the fingerprint is the dedup key (CLAUDE.md invariant: idempotent
        ingest; raw insert-once by id), B's distinct record collapses onto A's → events are silently
        dropped. VERIFIED live: two distinct jsonl lines parsed as separate "files" produced identical
        fingerprint 48d9389845…. The built-ins avoid this via a globally-unique uuid (Claude) or
        one-session-per-file layouts; the generic custom connector is uniquely exposed, and every test
        parses a single text so none catches it.
suggestion: A true fix is blocked by the frozen parse(fileText) contract (the plan forbids changing the
        Connector interface), so make the constraint loud rather than silent:
        (1) Add to fidelity.knownGaps: "rawId is `${sessionId}:lineIndex` — map a sessionIdField that is
            unique per logical session (ideally one session per file), or events sharing a line index
            across files will dedup-collide." 
        (2) State the same in docs/guide/custom-connectors.md §6 (it currently only warns that attribution
            relies on projectPathField).
        Optionally, have validateCustomDef surface an advisory when sessionIdField is absent.
```

```
severity: low
file: apps/collector/src/serve.ts
line: 124
issue: runServe now performs filesystem I/O (loadRegistry → reads ~/.420ai/custom-connectors.json) at init even in tests.
detail: Previously the default registry was the in-memory `defaultConnectors`. Now, when deps.connectorRegistry
        is not injected, runServe calls loadRegistry(home) with home defaulting to homedir(). The base
        makeHarness (serve.test.ts:75-87) injects neither `home` nor `connectorRegistry`, so the lifecycle
        tests ("emits ready + initial status on boot", start/pause/resume, etc.) now read the real
        ~/.420ai/custom-connectors.json. They pass today only because that file is absent on this machine
        (tolerant → builtins). A developer or CI image with a malformed/colliding file would get extra
        boot-time `{type:"log",level:"warn"}` events — harmless to current assertions (they pin only
        events[0]/[1], emitted before the dropped-warn loop) but a real hidden-FS-dependency / isolation
        regression in previously-pure tests.
suggestion: Default `home` to a mkdtemp dir in makeHarness (or add `home`/`connectorRegistry: []` to the
        base deps) so serve tests never touch the real collector home. Keeps the new custom tests, which
        already inject a registry, unaffected.
```

```
severity: low
file: apps/collector/src/connectors/custom-connector.ts
line: 148
issue: validateCustomDef requires a (?<ts>…) group for regex even when tsField is absent and the timestamp is unused.
detail: For format:"regex", validation rejects unless the pattern contains `(?<${tsField ?? "ts"}>`. But the
        factory only reads ts when `def.tsField` is set (`def.tsField ? read(def.tsField) : undefined`);
        with no tsField, ts always falls back to ingestedAt and the group is never consumed. So a user who
        writes a regex with no ts group and no tsField (intending capture-time timestamps — exactly the
        Level-4/doc example's effective behavior, which only passes because it happens to include an unused
        (?<ts>) group) is rejected with a confusing "must name a (?<ts>…) group". This matches the frozen
        plan spec and is documented, so it is intentional — flagging the factory/validator inconsistency
        only, not a defect.
suggestion: Either (a) require the ts group only when def.tsField is set (so a capture-time-only regex is
        accepted), or (b) leave as-is but note in the doc that a `(?<ts>)` group is required even when you
        don't map it. Lowest-effort: keep per-spec; the doc already mentions the requirement.
```

```
severity: low
file: apps/collector/src/connectors/custom-connector.ts
line: 226
issue: A user-supplied regex is executed against every log line — a pathological pattern can ReDoS the watcher.
detail: makeCustomConnector compiles def.pattern and runs `re.exec(line)` per line on the watcher thread.
        A catastrophic-backtracking pattern would hang capture. The pattern comes from the machine owner's
        own ~/.420ai/custom-connectors.json (local, mode 0600) — there is no remote injection vector, so
        this is self-inflicted DoS only. Noting for completeness given it's user-controlled regex on a hot path.
suggestion: Acceptable to leave given the local-only threat model. If desired later, document "avoid
        nested quantifiers / catastrophic backtracking" in the guide; a per-line timeout is overkill here.
```

---

## Verification performed

- **rawId stability across ticks** — read `watcher/tailer.ts`; confirmed whole-file-prefix read (not delta).
- **HIGH null-crash** — ran `loadRegistry` against `{connectors:[null,5,"x"]}` → threw (reproduced).
- **MEDIUM cross-file collision** — parsed two distinct jsonl "files" with no sessionIdField → identical
  fingerprint (reproduced). (A regex repro was abandoned after confirming the failure was shell-escaping
  mangling of `\S`, per the plan's own warning — the vitest regex test matches correctly.)
- **LOW serve FS dependency** — read serve.test.ts:75-146; base harness injects neither home nor registry.
- Full suite green at commit time: `npm run repo-health` PASS (326 tests, all typecheck lanes 0 errors).

## Recommendation

Fix the **HIGH** null-crash before merge — it's a one-line guard that restores the D4 tolerance invariant,
plus one regression test. The **MEDIUM** is a doc/knownGap change (the code fix is contract-blocked). The
LOWs are optional polish.
