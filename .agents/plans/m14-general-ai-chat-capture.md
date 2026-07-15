# M14 — General AI Chat Capture (+ deferral sweep)

> **Milestone definition** — the output of the 2026-07-14 deferral audit + scope conversation
> (the same process that produced M12 and M13). Conventions live in `CLAUDE.md`; this links,
> not re-pastes. Each slice below still goes through the build loop (`SUMMARY.md` §2) with its
> own `/lril:plan-feature` plan; **slices 14.5+ cannot be planned until the 14.0 spike lands.**

## Origin — the 2026-07-14 deferral audit

A full sweep of `docs/` (PRD §1/§4/§25, CONTEXT, guides, research), `.agents/` (plans,
code-reviews, execution-reports, system-reviews), and source comments. Findings, deduplicated:

- **A. Parked by decision (stay parked):** MSI/WiX, CA/Authenticode signing, CI release
  workflow; multi-user/RBAC/tenancy, SaaS, mobile; Antigravity (no tokens/cost, schema-less
  protobuf); semantic/vector search; in-tool context-rule enforcement; subscription cost
  amortization; script/plugin connector runtime; local-model lifecycle; scheduled _analysis_.
- **B. Small tracked deferrals, open (none picked up by M13):** per-event/per-tool-call search
  granularity (12.1); dashboard catalog admin UIs — connector-catalog approve/reject +
  pricing-catalog upload (12.7c, CLI-only today); desktop polish — `connectorHealth` in the
  desktop panel (12.7c), GUI unpair (`apps/desktop/src-tauri/src/server.rs` deferral),
  `/api/auth/me` admin-email in nav (12.3); typed per-report-type metrics diff (12.2b);
  git patch-text capture (§11.3, numstat-only); machine/token revoke UI; editable settings.
- **C. Maintainer manual actions outstanding (not code):** the updater **signing-key ceremony**
  (`tauri.conf.json` still carries `REPLACE_WITH_TAURI_UPDATER_PUBKEY` — **auto-update is
  non-functional until done**); restore-from-backup drill; live auto-update E2E; 12.3 auth live
  QA + screenshots (`.agents/qa/` never got an m12 folder); live SMTP send; scheduled-reports
  cold run; the Cursor `watch → archive → Monitor` live round-trip (named a pre-sign-off step
  in 13.7 but never recorded as run).
- **D. Truth/hygiene debt:** README roadmap stale (shows M12 "in progress"; M12+M13 are DONE);
  stale "deferred to 12.4" comments in `apps/ingest/src/routes/auth.ts` + `server.ts` (rate
  limiting shipped); stale "replay deferred" wording in `docs/CONTEXT.md` +
  `scripts/CATALOG-SIGNING.md` (shipped 12.5a/13.3); stale unchecked Cursor box in
  `docs/research/connector-capture-spike.md`; **no M12/M13 system-review** exists
  (latest retro is m7–m9); spike follow-ups never confirmed (Codex `session_meta` cwd/git,
  Gemini `projectHash` stability).
- **E. The candidate itself:** the **General AI Chat capture-surface spike is unrun** — nothing
  in the repo names where ChatGPT / Claude web+desktop / Gemini web conversations live locally.
  The existing spike covered coding-tool CLIs only. PRD §1/§4 name chat capture + multi-user as
  the only firm V2 commitments.

## Scope decisions (settled 2026-07-14 — do not re-litigate)

- **D-M14-1 — M14 = General AI Chat capture**, promoted from the PRD §25 sketch (item 14).
  Cross-platform collectors, advanced intelligence, and the rest of the sketch stay unpromoted.
- **D-M14-2 — Spike-first, all four surfaces.** Slice 14.0 investigates **Claude web + desktop,
  ChatGPT web + desktop, Gemini web, and the browser-extension mechanism as a first-class
  question** (not just per-tool stores). The connector slices (14.5+) are shaped by its outcome:
  official data exports vs. local app stores vs. extension capture. Mirrors the V1
  connector-capture spike and the 12.7d research gate: **ship what's feasible, never block the
  milestone on a gated surface.**
- **D-M14-3 — Three category-B pull-ins ride along** as independent thin slices: catalog admin
  UIs, the desktop polish trio, per-event search granularity. The rest of category B stays in
  the deferral bucket.
- **D-M14-4 — Truth slice + gated checklist.** A 13.1-style truth slice fixes category D, and
  the category-C maintainer actions become a **named pre-sign-off checklist in this plan** —
  the milestone does not sign off while any box is unchecked (the 13.7 lesson: an unnamed
  manual step slips).
- **Non-goals (unchanged, per PRD §4 + the M12 list):** multi-user/RBAC/SaaS, MSI/code
  signing/CI release, Antigravity, semantic/vector search, mobile, in-tool enforcement,
  scheduled analysis.

## Slices (dependency order)

- **14.0 — General AI Chat capture-surface spike.** Read-only recon on this machine (+ the
  browser): where do Claude web/desktop, ChatGPT web/desktop, and Gemini web conversations
  live (local stores? official exports? network-only)? What fidelity is recoverable (tokens,
  model, tool calls, timestamps)? Is a browser extension the common denominator, and what
  would its capture/delivery path be? Output: `docs/research/chat-capture-spike.md` with a
  per-surface feasibility verdict + recommended capture mode each (mirrors
  `connector-capture-spike.md`). **Gates 14.5+.**
- **14.1 — Truth & hygiene.** Category D: README roadmap (M12/M13 → DONE, M14 → planned);
  stale rate-limit/replay comments; spike checkbox; write the **M12/M13 system-review**
  (`.agents/system-reviews/m10-m13-review.md`); confirm-or-file the Codex/Gemini spike
  follow-ups. No product code change beyond comment text.
- **14.2 — Catalog admin UIs.** Dashboard connector-catalog approve/reject + pricing-catalog
  upload (upload stays offline-**signed** — the UI submits the signed document; the private
  key never touches the browser). Existing endpoints; dashboard-only; proxy discipline per
  `CLAUDE.md`.
- **14.3 — Desktop polish trio.** `connectorHealth` surfaced in the desktop panel
  (`ConnectorInfo`/`mapConnectorInfo` widening), GUI unpair, admin-email in dashboard nav via
  `/api/auth/me` proxy. Additive; control-protocol version bump only if the wire shape changes.
- **14.4 — Per-event search granularity.** Finer-grained `search_documents` rows (per-event or
  per-tool-call) behind the same redact-then-store pipeline; incremental index sites (13.4)
  extended; UI results grouped by session. Needs care on index size + reindex cost.
- **14.5+ — Chat connectors (shaped by 14.0; sliced after it lands).** Per-surface connectors
  normalizing onto the **existing event taxonomy** (no fingerprint change — invariant), plus
  **non-repo attribution** (Work-Session/topic grouping instead of project/git). If the spike
  says extension-first, the extension is its own slice with a collector hand-off (likely a new
  capture mode, mirroring how 13.7 added `poll`).

## Pre-sign-off checklist (D-M14-4 — every box, maintainer manual)

- [ ] Updater signing-key ceremony run; `tauri.conf.json` placeholder replaced; key in
      `.secrets/` (runbook: `docs/guide/operations.md` §13.1)
- [ ] Restore-from-backup drill into a scratch DB, verified
- [ ] Live auto-update E2E (needs the ceremony first)
- [ ] 12.3 auth live QA + screenshots → `.agents/qa/m12-slice3/`
- [ ] Live SMTP alert send (opt-in env set, one real email observed)
- [ ] Scheduled-reports cold run (`reports:generate` against a live stack)
- [ ] Cursor live round-trip: `collector watch → archive → Monitor` shows a Cursor session
