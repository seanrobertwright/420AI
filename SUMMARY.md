# 420AI — Working Summary & Execution Flow

> A one-page mental model. The full spec is [`docs/PRD.md`](./docs/PRD.md); the domain
> glossary is [`docs/CONTEXT.md`](./docs/CONTEXT.md). This file captures **what we're building,
> how we'll build it, and the decisions made so far.**

---

## 0. Status — 2026-06-15

**V1 is ~90% built.** Milestones **1–9 are implemented and on `main`** (M9 Live Monitor merged via
PR #12). **M10 (hardening)** is a *bundle* and is being built in slices: the **operational-alerts slice
is done** — a **stateless derived projection** (`deriveAlerts` in `@420ai/shared`) folded into the M9
Live Monitor snapshot (no new table, no migration, no long-lived dispatcher), surfaced as an Alerts
panel on `/monitor`; the snapshot stamp bumped `m9-monitor-v1` → `m10-monitor-v1`. The remaining M10
bundle items — **exports (§22), catalog signing (§10.4/§18), replay metadata (§23)**, and the richer
**persisted alert engine** (firing history/ack + heartbeat time-series for "backlog growing") — still
remain. **M11 (Tauri desktop/tray collector)** is the first *post-V1* milestone — planned and added to
the PRD (§25) with a feasibility spike
([`docs/research/m11-tauri-sidecar-spike.md`](./docs/research/m11-tauri-sidecar-spike.md)) — not yet built.

**CI gate:** a `repo-health` GitHub Actions check (repo-root `tsc -b` + NUL/stray scans + the full
vitest suite **including the Postgres integration layer**) runs on every PR to `main`
(`.github/workflows/repo-health.yml`).
⚠️ It is **not yet a hard *blocking* required check** — branch protection on a **private** repo needs
**GitHub Pro**. Until that's resolved: **never merge a PR whose `repo-health` check is red.** (One red
merge already slipped through — M8 / PR #7 merged with a typecheck error — and needed hotfix PR #8.)

---

## 1. What we're building (one breath)

A **self-hosted AI Coding Session Intelligence Platform**: it captures every AI coding-tool
session on your machine(s), archives them with full fidelity, and turns them into Markdown
reports about **cost, token/context efficiency, tool-call failures, and Git outcomes** — so you
can see which projects/tools/models are worth the spend and where context is wasted.

- **Local-first, self-hosted.** Nothing leaves your home server.
- **Event-sourced.** Raw records are the permanent truth; everything else is a re-buildable projection.
- **Deterministic metrics first, AI interpretation second.**

```mermaid
flowchart LR
    T[AI Tools<br/>Claude Code · Codex · Gemini] -->|JSONL files| C[Collector<br/>tails files]
    C --> Q[(Durable Queue)]
    Q -->|token-auth| I[Ingest API]
    I --> A[(Central Archive<br/>Supabase/Postgres)]
    A --> D[Dashboard<br/>Next.js + shadcn]
    D --> U((You))
```

---

## 2. The build LOOP (per feature)

These skills run **once per feature**, not once for the whole project. Walk down the PRD
milestones (§25), running this loop for each:

```mermaid
flowchart TD
    P["/lril:plan-feature 'X'"] --> R{Read plan +<br/>confidence score}
    R -->|good| E["/lril:execute &lt;plan&gt;"]
    R -->|gaps| P
    E --> CR["/lril:code-review"]
    CR --> Q{Issues?}
    Q -->|yes| F["/lril:code-review-fix"]
    F --> CR
    Q -->|clean| CM["/lril:commit"]
    CM --> ER["/lril:execution-report"]
    ER --> N[Next feature]
    N --> P
```

| Step | Skill | Produces | Code? |
|---|---|---|---|
| 1. Plan | `/lril:plan-feature "<feature>"` | `.agents/plans/<name>.md` + confidence score | No |
| 2. Build | `/lril:execute <plan-path>` | code + tests, runs validations | **Yes** |
| 3. Review | `/lril:code-review` | `.agents/code-reviews/<name>.md` (pre-commit gate) | No |
| 4. Fix | `/lril:code-review-fix` (if needed) | fixes; re-review until clean | Yes |
| 5. Commit | `/lril:commit` | the commit | — |
| 6. Reflect | `/lril:execution-report` | `.agents/execution-reports/<name>.md` (improves next loop) | No |

**Rules of thumb**
- Always **read & correct the plan** before executing — cheapest place to catch a wrong approach.
- `/lril:prime` at the **start of each session** to reload context.
- `/lril:system-review` periodically; `/lril:rca` when something breaks.
- Bootstrap: first feature establishes the conventions every later feature mirrors.

---

## 3. Build ORDER (PRD §25 milestones)

**V1 (M1–M10):**
1. ✅ Walking skeleton: **one connector (Claude Code) → ingest → store → one report.**
2. ✅ Archive deployment: Docker Postgres, migrations, ingest API, pairing flow, field encryption.
3. ✅ Collector foundation: durable queue, machine identity, ingest sync, connector framework, per-file cursors.
4. ✅ Connectors to full fidelity: Claude Code lifecycle/file/context, then Codex + Gemini.
5. ✅ Project/workspace mapping (repo discovery + attribution resolver).
6. ✅ Event projections: sessions, usage, cost, connector health, Git metadata.
7. ✅ Reporting: deterministic metrics + durable, versioned Markdown report artifacts.
8. ✅ AI interpretation: redaction engine + decrypt-for-render + configurable provider (Anthropic + OpenAI-compatible).
9. ✅ Live Monitor: collector heartbeat → real-time monitor API + SSE → first Next.js dashboard (shadcn/theGridCN).
10. ⬜ Hardening: exports, catalog signing, alerts, replay metadata.

**Post-V1:**
11. ⬜ **Tauri desktop/tray collector** — sidecar shell over the headless collector (node:sea), theGridCN UI,
    tray + connector mgmt + sync/health + pairing/autostart + settings (collector & server config, secrets in
    OS keychain). Planned & in the PRD; ready for `/lril:plan-feature`.

> **Principle:** nothing shows value until the pipe is whole — so make the *thinnest* end-to-end
> pipe first (milestone 1), then thicken each stage.

---

## 4. DECISIONS LOG (from PRD review)

### Connector capture (Q1) — confirmed feasible on this machine
| Tool | Location | Format | Liveness |
|---|---|---|---|
| **Claude Code** (required) | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL, append | Streaming (tail) |
| **Codex CLI** (required) | `~/.codex/sessions/YYYY/MM/...` + `history.jsonl` | JSONL | Streaming |
| **Gemini CLI** (required) | `~/.gemini/tmp/<projectHash>/chats/session-*.json` | JSON | Near-real-time |
| **Antigravity** (stretch) | `~/.gemini/antigravity-*` | JSONL + protobuf | Partial — gated (no token/cost) |
| **Cursor** (stretch) | `~/.cursor/...` (chat store actually in `%APPDATA%\Cursor`) | SQLite | Snapshot/poll |

**Done:** spike completed → [`docs/research/connector-capture-spike.md`](./docs/research/connector-capture-spike.md).
All three required connectors record **exact tokens + model + tool calls**; none report cost (computed from
tokens × catalog pricing).

### Liveness (Q2) — "as live as the format allows, labeled honestly"
- Watch files, read only **newly appended lines**, push to queue, flush every few seconds.
- Track a per-file **byte-offset cursor** so restarts resume instead of re-sending.
- Liveness is a **per-connector fidelity label**: Streaming (JSONL) / Snapshot (SQLite) / Batch (protobuf).
- Live Monitor shows **"last event N sec ago"** — never fake real-time.

### MVP success criteria (Q3) — contradiction removed
- **Required:** Claude Code + Codex CLI + Gemini CLI (all confirmed JSONL).
- **Stretch / research-gated:** Antigravity + Cursor — ship when verified, never block MVP.

### Git outcome attribution (Q4) — split into two layers
1. **Git metadata** (build now, 100% factual): hash, author, time, branch, changed files, line counts.
2. **Linking** (keep simple): manual link + one heuristic suggestion
   *(same repo + commit within X min of session end + ≥1 file overlap → low/med-confidence suggestion to confirm)*.
   Defer the full weighted scorer. Always show confidence; auto-links are suggestions, not facts.

### Replay reconciliation (Q5) — upsert-by-fingerprint
- **Principle:** raw records are sacred & permanent; normalized events are disposable/re-buildable.
- **Fingerprint** = `hash(source_connector + raw_record_id + event_index + event_type)` — deterministic.
- Re-parse → upsert by fingerprint, stamp `parser_version`. (Same primitive also powers Q4's "already attributed?".)
- Simple now; the stored `parser_version` keeps the door open to versioned generations later.

### Pricing & cost (Q6) — catalog table + fallback ladder
- Pricing lives in the **catalog**: `model → {input/output $/token, source, as-of date}`.
- Ladder: **tool/provider-reported** → else **estimate (model known)** → else **estimate (model unknown)**, each labeled with confidence.
- Updates: **manual trigger first** ("Check for pricing updates"); optional schedule later.

### Security (Q7) — field-level encryption from day one
- **Encrypt:** message bodies, tool-call args/outputs, file contents, command output, detected secrets.
- **Plaintext (queryable):** timestamps, model, project/workspace IDs, token counts, costs, event type, fingerprint.
- Key held by the app/server, **not** in the DB; decrypt only to render or to feed redaction.
- **Tension:** can't full-text-search encrypted data (PRD §21).
  **Resolution:** search a **redacted plaintext projection** (secrets masked); keep originals encrypted.

### Smaller decisions — all accepted
- ✅ **Defer Tauri** — Node/TS collector first (single language); the tray/desktop app is now **M11** (post-V1), sidecar architecture, theGridCN UI.
- ✅ **theGridCN** with plain shadcn/ui as fallback (dashboard **and** the M11 desktop app).
- ✅ **Defer Parquet** — V1 exports = Markdown / JSON / JSONL / CSV.
- ✅ Add rough **volume/retention** numbers to the PRD.
- ✅ Name a simple **regex/entropy redaction engine** for V1 (shipped in M8).

---

## 5. Key principles to keep in your head

1. **Raw records sacred, projections disposable** — you can always recompute, so you can never lose data.
2. **Deterministic fingerprint** does double duty: dedup/idempotency (Q5) *and* "already attributed?" (Q4) — design it early.
3. **Thinnest end-to-end pipe first** — value only appears when the whole pipe exists.
4. **Liveness is capped by file format**, not effort — JSONL tails, SQLite polls; label it honestly.
5. **Encrypt originals, search a sanitized copy** — reconciles privacy with search.
6. **Plan-heavy, code-light loop** — read & fix the plan before executing; reflect after to improve the next loop.

---

## 6. Immediate next steps

- [ ] **M10 (hardening)** — exports, catalog signing, operational alerts, replay metadata → completes V1.
      It's a *bundle*, not one feature; scope the slice up front (operational alerts is the natural first
      cut — M9 ships the `online`/`stale`/`offline` + `backlogHigh` states as its inputs). See the M10
      forward-guidance in [`.agents/system-reviews/m7-m9-review.md`](./.agents/system-reviews/m7-m9-review.md).
- [ ] **Resolve CI enforcement:** branch protection needs **GitHub Pro** (private repo). Until then, treat the
      `repo-health` check as advisory — **don't merge red**. (Alternative: make repo public, or gate the
      automated-merge step on the check.)
- [ ] **Plan M11 (Tauri)** via `/lril:plan-feature` — resolve the two open design points: the UI↔sidecar
      control protocol, and whether the app supervises the local server-stack lifecycle.
