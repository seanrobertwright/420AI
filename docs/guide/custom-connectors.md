# 420AI — Custom Connectors

Point the collector at **any** append-only file or log a built-in connector
(`claude-code` / `codex-cli` / `gemini-cli`) doesn't already cover — another AI CLI's JSONL
transcript, a wrapper script's structured log, an MCP server's audit log — and map its fields onto
420AI's normalized events. You declare the connector as **data**; you never write or run code.

> **Config-only, by design.** A custom connector is a declarative mapping interpreted by a fixed
> factory. There is no scripting or plugin runtime (PRD §39/§217 non-goal): the only things you can
> express are JSON dot-paths and a regular expression.

---

## 1. Where it lives

Declarations go in a single JSON file in the collector home:

```
~/.420ai/custom-connectors.json      (written with mode 0600)
```

- **Absent or corrupt ⇒ no custom connectors.** The built-in connectors keep capturing exactly as
  before — a misconfiguration never takes down capture.
- An **invalid** or **id-colliding** declaration is **skipped with a reason**, not fatal; the rest
  of the file still loads.

Inspect what the collector parsed (read-only — it never writes the file):

```
collector custom
```

Example output:

```
1 custom connector(s):
  custom-mytool  (format regex, status experimental, 1 glob(s))
Config: C:\Users\you\.420ai\custom-connectors.json
```

A dropped declaration prints its reason, e.g. `dropped custom-bad: connector "custom-bad": watchGlobs must be a non-empty string[]`.

---

## 2. File schema

```jsonc
{
  "version": "m10-custom-v1",
  "connectors": [
    {
      "id": "custom-mytool", // REQUIRED. Non-empty, unique, NOT a built-in id.
      //   Recommended: a "custom-" prefix.
      "displayName": "My Tool", // optional, cosmetic
      "watchGlobs": ["C:/tmp/mytool/*.log"], // REQUIRED. Absolute glob(s). Forward slashes
      //   work on every OS. `~` is NOT expanded — use a full path.
      "format": "jsonl", // REQUIRED. "jsonl" | "regex"
      "pattern": "…", // REQUIRED iff format === "regex" (see below)

      // Field sources. For "jsonl" these are DOT-PATHS into each parsed line
      // (e.g. "meta.session"); for "regex" they are named-capture GROUP NAMES.
      "tsField": "timestamp",
      "sessionIdField": "session",
      "projectPathField": "cwd",
      "modelField": "model",
      "eventTypeField": "kind", // per-line event type; see §4

      "eventType": "message.assistant", // constant fallback when eventTypeField is absent/empty

      // Optional usage mapping (numeric sources). Present ⇒ fidelity.tokens = "estimated".
      "tokenMap": { "input": "usage.in", "output": "usage.out" },
    },
  ],
}
```

Every field source is **optional except as noted**. An unmapped field is simply absent on the
resulting event; a missing timestamp falls back to the capture time.

---

## 3. The two formats

### `jsonl` — one JSON object per line

Each non-blank line is `JSON.parse`d, then each field source is read as a **dot-path**.

```jsonc
// declaration
{
  "id": "custom-mytool-json",
  "watchGlobs": ["C:/logs/mytool/*.jsonl"],
  "format": "jsonl",
  "tsField": "meta.ts",
  "sessionIdField": "meta.session",
  "projectPathField": "cwd",
  "eventTypeField": "kind",
  "tokenMap": { "input": "usage.in", "output": "usage.out" },
}
```

```jsonc
// a matching log line
{
  "meta": { "ts": "2026-06-19T00:00:00Z", "session": "s1" },
  "cwd": "/proj",
  "kind": "message.assistant",
  "usage": { "in": 10, "out": 20 },
}
```

→ one `message.assistant` event for session `s1`, project `/proj`, with `input=10`, `output=20`.

### `regex` — one line, named-capture groups

Each line is matched against `pattern`; field sources name the capture groups (`match.groups`).
If you set `tsField`, the pattern **must** name a group with that exact name; otherwise the timestamp
falls back to the capture time and no `ts` group is required.

```jsonc
{
  "id": "custom-mytool",
  "watchGlobs": ["C:/tmp/mytool/*.log"],
  "format": "regex",
  "pattern": "^(?<ts>\\S+)\\s+session=(?<sessionId>\\S+)\\s+kind=(?<kind>\\S+)\\s+(?<msg>.*)$",
  "tsField": "ts",
  "sessionIdField": "sessionId",
  "eventTypeField": "kind",
}
```

```
2026-06-19T00:00:00Z session=s2 kind=message.user opened the file
```

→ one `message.user` event for session `s2`. A line that doesn't match the pattern is skipped
(counted, never fatal).

> **Keep the pattern linear.** Your regex runs against every line on the capture thread. Avoid nested
> quantifiers and overlapping alternations (e.g. `(\S+)+`, `(a|a)*`) that can backtrack
> catastrophically — a pathological pattern can stall capture. Prefer specific character classes
> (`\S+`, `[^ ]+`) over `.*` where you can.

---

## 4. Choosing the event type

A custom connector may map onto **only** the existing closed event taxonomy — no new event types:

```
session.started   session.ended
message.user      message.assistant
tool.call.started tool.call.completed   tool.call.failed
file.read         file.modified         file.referenced
context.loaded
usage.reported    cost.estimated
```

Resolution per line:

1. If `eventTypeField` is set and the line's value is one of the types above → use it.
2. Otherwise fall back to the constant `eventType`.
3. If neither yields a mappable type → the line is **skipped** (counted in `skippedLines`).

You must provide at least one of `eventTypeField` or `eventType`, or the declaration is rejected.

---

## 5. Tolerance — nothing here breaks capture

- A **blank** line is ignored.
- An **unparseable** line (bad JSON, or no regex match) is skipped and counted.
- A line whose resolved event type isn't mappable is skipped and counted.
- An **invalid declaration** (empty `watchGlobs`, bad regex, unknown `eventType`, a `tsField` that
  names no group in the pattern) is dropped with a reason — the other declarations and all built-ins
  keep running.
- An **id collision** (with a built-in or another custom def) drops the later one; **first wins**.

---

## 6. Fidelity — honest by default

Custom connectors are labeled **experimental** and report their limits truthfully (the Live Monitor
and desktop UI surface these):

- `status: "experimental"`, `captureMethod: "custom-tail-<format>"`, `liveness: "streaming"`.
- `tokens: "none"` **unless** you configure a `tokenMap` (then `"estimated"`); `cost: "none"`.
- **No workspace discovery.** Custom connectors don't enumerate project roots, so they're skipped by
  `collector discover`. Project attribution relies entirely on a mapped `projectPathField`.

> **Map a unique `sessionIdField`.** Each event is keyed by `` `${sessionId}:lineIndex` ``. If several
> files match one glob and don't carry a session id unique per logical session (or you omit
> `sessionIdField` entirely), lines that share a line index across files produce the **same key** and
> the later one is silently deduplicated away. Map a `sessionIdField` that is unique per session —
> ideally one logical session per file — so nothing is dropped.

Custom connectors appear in the desktop **Connectors** panel flagged as user-defined, and honor the
same enable/disable toggle as the built-ins.

---

## 7. End-to-end check

1. Write `~/.420ai/custom-connectors.json` (use the `regex` example above, pointed at a real path).
2. `collector custom` → confirm your connector is listed with 0 drops.
3. Append a line to the watched file, run `collector watch` briefly, then `collector queue` /
   inspect the archive: a raw record + event under your `id` should appear.
4. Break the JSON (delete a brace) → `collector custom` still runs, reports 0 connectors, and
   `collector watch` still captures the built-ins.
