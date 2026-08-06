# Local data boundary

**What 420AI captures, encrypts, indexes, exports and deletes — on your own machine.**

Written 2026-08-02 by milestone slice 16.0, for research-plan Phase 0 item 7 and §7 P0.4
(_"a design partner can make an informed decision before pairing a machine"_).

> **Every claim in this document is derived from source and cited by `file:line`.** Where the code
> does not do something, this document says so rather than describing an intention. That is the
> entire value of the page: a design partner is being asked to point a capture agent at their real
> work, and one aspirational sentence here makes the rest of it untrustworthy.
>
> Line numbers drift. If a citation does not match, **trust the code and fix this page** — do not
> assume the behaviour changed to match the prose.

**The shape of it in one paragraph.** 420AI is self-hosted: the collector reads session files on
your machine and posts them to an archive (Postgres) that you run. Nothing is sent to a 420AI
service, because there isn't one. Transcript bodies are encrypted at rest with a key held in your
environment and never in the database; timestamps, token counts, model names and file paths are
stored as queryable plaintext by design. Search runs over a **redacted copy**, never the encrypted
original. Exports are redacted before bytes leave the archive. **Your captured work is never deleted
automatically** — see §6, which lists the four bounded exceptions (none of them your sessions) and is
the section most likely to surprise you.

---

## 1. What is captured

Capture is per-connector, and a connector reads **only** the paths its declared capture scope names.
Those declarations are the "Capture Permission" you review, and widening one is a **Capture Surface
Change** that requires fresh approval before it captures again
(`apps/collector/src/connectors/connector.ts:38-46`).

> **EVERY REGISTERED CONNECTOR IS ENABLED BY DEFAULT.** This is the most important sentence on the
> page, so it comes before the table rather than after it.
> `apps/collector/src/connectors/connector-config.ts:33-34` defines the config map as _"a missing id
> ⇒ enabled (default-on)"_, `:37` calls the empty override set _"the safe default — no overrides, so
> every connector is enabled"_, and `filterConnectors` (`:67-71`) removes only connectors **explicitly**
> disabled. There is no allow-list. A connector whose source paths exist on your machine **will**
> capture unless you turn it off.

The connectors this deployment **intends** to observe are fixed by **D-M16-1**
(`.agents/plans/m16-dogfood-instrumentation.md`) — but that is a written commitment, not an enforced
configuration, and the two must not be confused:

| Connector       | Declared capture scope (`requiredPermissions`)                                                            | Liveness  | Tokens | Cost     |
| --------------- | --------------------------------------------------------------------------------------------------------- | --------- | ------ | -------- |
| **Claude Code** | Read Claude Code session transcripts under `~/.claude/projects/*/*.jsonl` (`claude-code.ts:94-96`)        | streaming | exact  | computed |
| **Codex CLI**   | Read OpenAI Codex CLI rollout logs under `~/.codex/sessions/*/*/*/rollout-*.jsonl` (`codex-cli.ts:92-94`) | streaming | exact  | computed |

**Six further connectors ship in the registry** (`connectors/connector.ts:1-9`: Gemini CLI, Cursor,
the Claude/ChatGPT/Gemini export connectors, and `claude-live`). Until each is explicitly disabled,
they are **live**, and disabling is a deliberate per-connector action rather than the default.

This is not a theoretical caveat. The 2026-08-02 clean-room deploy
([`.agents/research/cleanroom-2026-08-02.md`](../../.agents/research/cleanroom-2026-08-02.md))
measured a collector that logged `watching 8 connector(s)`, and the **Cursor** connector captured
`260/350 session(s) changed → 16,916 records / 39,888 events` from the operator's real Cursor store —
in a run that had been set up to be isolated. See **INC-2026-01**
([`incidents.md`](../../.agents/research/incidents.md)): the Cursor connector is poll-mode and its
`sources()` discards the `--home` argument its own contract passes it
(`connectors/cursor.ts:331`), reading `%APPDATA%` instead. So for that connector, **`--home` does not
confine capture at all.**

**If you are evaluating whether to pair a machine, act on the paragraph above, not on the table.**

> **M16 16.3 (F-16.3-1) — disabling a connector now actually works on `collector watch`.** Until that
> fix `watch` ignored `connectors.json` **and** capture-surface approvals entirely, passing the whole
> registry through to the capture engine; only the desktop `serve` path applied them. Since the
> Windows service runs `watch --home <you>`, turning a connector off could leave it capturing. Both
> filters are now applied on both paths. **This does not change default-on** — an absent id still
> means enabled, so the warning above stands unaltered; it only means the off switch is real.

### What a heartbeat carries (M16 16.3)

Every ~30 s the collector posts machine liveness (queue depth, collector version) and, since 16.3,
its **declared connector inventory**, so the archive can distinguish "no work happened" from "capture
is broken". Per connector that is: the connector id, whether it is enabled, its approval state,
capture method, liveness, token/cost fidelity, known gaps, its human-readable
`requiredPermissions` statements, and its **latest capture error message with a count**.

- **An error message may contain a FILE PATH, home-relativized.** That is deliberate — the path is
  usually the whole diagnostic (`EACCES … open '~/.claude/projects/…/session.jsonl'`) — and it is
  bounded to 500 characters. Your home directory is rewritten to `~` before it leaves the machine,
  so the diagnostic survives and your username does not.
- **`watchGlobs` are NOT sent** (D-16.3-3). They are absolute paths under your home
  directory, so shipping them would write your username and directory layout into the archive. The
  exclusion is enforced at the type level (`Omit<ConnectorInfo, "watchGlobs">` in
  `packages/shared/src/capture-health.ts`), pinned by a collector test, and enforced again at the
  HTTP edge, where the heartbeat schema does not declare the property and ajv strips it. The
  human-readable `requiredPermissions` — written for exactly this review — carry the same
  information at the granularity a person actually needs.

  **One honest caveat, because the earlier wording overstated this.** A **custom** connector's
  `requiredPermissions` are generated from its own globs, so they DO describe paths you chose. Those
  strings are home-relativized on the way out (`~/…`, as above), but unlike the built-ins' fixed
  wording they still reflect your directory layout below the home directory. If that matters for a
  particular source, point the custom connector at a path you are willing to name.

- **No session content, no transcript text, no tokens or credentials** travel on a heartbeat.

These rows live in `machine_connectors`, one per (machine, connector), overwritten wholesale on every
report. It is a projection of a live signal, not a history.

Per captured session the archive derives: connector and parser version, machine, workspace,
repository, project path, git branch, timestamp, tool-native session id, a durable event
fingerprint, model, token fields, cost with a confidence label, event/tool-call type and status, and
queue/sync state (`packages/db/src/schema.ts:435-480`).

**Git history is captured separately** and only when you run it: commits per repository, with
message, author name/email, branch, and changed-file/line stats (`schema.ts:679-720`). **Patch/diff
text is NOT captured** — `schema.ts:685` states full patch text is deferred. The collector reads
local `.git` directories; there is no GitHub API access and no Octokit dependency.

## 2. What is encrypted at rest

Field-level **AES-256-GCM**, authenticated — the auth tag makes decryption fail loudly on any
tampering with the ciphertext or the tag (`packages/db/src/crypto.ts:3-5,21`).

Encrypted columns:

- `raw_source_records.payload_ciphertext` / `_iv` / `_tag` (`schema.ts:422-424`) — the verbatim
  source record. **Not nullable**: a raw record always carries an encrypted payload.
- `events.payload_ciphertext` / `_iv` / `_tag` (`schema.ts:472-475`) — the tool-call payload.
  Nullable, because events without a payload store NULLs (`schema.ts:472`).
- `git_commits.message_ciphertext` (`schema.ts:719`) — the commit **message** only.

**The key never touches the database.** The 32-byte key(s) come from the environment as base64 and
are _never stored in the DB_ (`crypto.ts:17-19`). A fresh 96-bit IV is generated per call and stored
beside the ciphertext (IVs are not secret, but must never repeat under one key).

**Two key modes, and the difference is visible in your data** (`crypto.ts:6-15`):

- **Legacy single-key** — only `ARCHIVE_ENCRYPTION_KEY` set. Ciphertext is bare base64.
- **Keyring** — `ARCHIVE_ENCRYPTION_KEYS` + `ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID`. New ciphertext is
  prefixed with the active key id (`"v2.AbCd…"`). Old and new keys coexist, so a rotation can
  re-encrypt row by row while un-rotated rows still decrypt.

Rotation is operator-run, not automatic — see `packages/db/src/repositories/key-rotation.ts` and the
key-rotation section of [`operations.md`](./operations.md).

## 3. What is deliberately NOT encrypted, and why

This is a design decision, not an oversight, and it is the honest half of the page.

**Timestamps, token counts, cost, model, and paths are plaintext because they must be queryable.**
`schema.ts:42-47` states the split directly: `events.tokens` / `events.cost` (jsonb) and
identity/timestamps/model/paths are plaintext, and notes that `project_path` / `git_branch` "are
plaintext metadata (paths, needed for project attribution in M5) — they are NOT secrets."

**Practical consequence worth stating plainly:** a file path can itself be sensitive — a project
path may name a client, an employer, or an unreleased product. That value is stored in the clear in
the archive you host. It _is_ masked on the way out (§4, §5: the `home_user_path` rule masks the
username segment), but inside your own database it is readable by anyone who can read the database.

**Git metadata is plaintext for the same reason** (`schema.ts:681-686`): author name/email, branch,
changed-file paths and numstat counts stay plaintext so attribution and reports can query them
_without decrypting_. The commit **SHA** is plaintext because it is git's own content hash and
serves as the idempotency key (`schema.ts:687-689`).

**Report artifacts are plaintext** (`schema.ts:636-646`): the rendered `markdown` and the `metrics`
snapshot contain only derived metrics — counts, tokens, cost, model, paths, timestamps — none of
which is on the encrypt-list, so `report_artifacts` has no `payload_*` columns at all.

## 4. What is searchable

**Redact-then-store.** Search never reads the encrypted originals. The indexer decrypts a record,
runs the redaction pipeline over it, and stores **only the masked text**
(`packages/db/src/repositories/search.ts:29-32`). Every string written — titles included — passes
`redact()` first (`search.ts:135-136,156-157,256,317-318`), and each row stamps the redaction ruleset
identity in `search_documents.redaction_version` (`schema.ts:978`).

That stamp is currently:

```
m8-redact-v1
```

(`packages/shared/src/redaction.ts:18` — `REDACTION_VERSION`.) It is a stored value, so rows indexed
under an older ruleset remain identifiable after the rules change.

The redaction pipeline is pure and dependency-free (`redaction.ts:2-15`) and applies **13 regex rules
in most-specific-first order, plus 1 high-entropy backstop that runs last — 14 kinds in total**
(`redaction.ts:67-155` for the rules, `:215-226` for the entropy pass):

| #   | Rule (`ruleId`)             | What it masks                                                          |
| --- | --------------------------- | ---------------------------------------------------------------------- |
| 1   | `private_key_block`         | `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE KEY-----` blocks |
| 2   | `jwt`                       | JSON Web Tokens                                                        |
| 3   | `anthropic_key`             | `sk-ant-…`                                                             |
| 4   | `openai_key`                | `sk-…` / `sk-proj-…`                                                   |
| 5   | `aws_access_key`            | `AKIA…`                                                                |
| 6   | `github_token`              | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`                             |
| 7   | `google_api_key`            | `AIza…`                                                                |
| 8   | `slack_token`               | `xoxb-` / `xoxa-` / `xoxp-` / `xoxr-` / `xoxs-`                        |
| 9   | `connection_string`         | the credentialed authority prefix of `scheme://user:pass@`             |
| 10  | `bearer_auth`               | `Authorization:` / `bearer …`, header and assignment forms             |
| 11  | `generic_secret_assignment` | `api_key` / `secret` / `token` / `password` / `passwd` / `pwd` = value |
| 12  | `home_user_path`            | the **username segment only** of `/home/…`, `/Users/…`, `C:\Users\…`   |
| 13  | `email`                     | email addresses                                                        |
| 14  | `high_entropy`              | backstop sweep for high-entropy strings the named rules missed         |

**What a redaction finding records:** kind, rule id, match count, and the placeholder — **never the
raw matched value** (`redaction.ts:20-34`), and a unit test asserts no finding contains the secret.

**Honest limits.** This is a regex-plus-entropy scanner, not a guarantee. A secret in a format none
of the 13 rules match and whose entropy falls under the backstop's threshold will be indexed in the
clear. The encrypted original is never indexed, so the exposure is bounded to the search projection —
but "redacted" here means "these 14 classes were masked", not "no secret can survive".

## 5. What can be exported

Four export surfaces, all authenticated, all redacted before the bytes leave the archive — three in
`exports.ts` (whose header at `apps/ingest/src/routes/exports.ts:33` states the §18 gate for them)
plus the M16 label export in `apps/ingest/src/routes/outcome-labels.ts:393-432`:

| Endpoint                                                           | Content                              | Redaction                                                        |
| ------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------- |
| `GET /v1/exports/events` (`exports.ts:150`)                        | Event stream, plaintext columns only | `redactJson(rows)` (`exports.ts:193`)                            |
| `GET /v1/reports/:id/export` (`exports.ts:232`)                    | A rendered report artifact (md/json) | `redactJson(…)` (`exports.ts:252`)                               |
| `GET /v1/sessions/:sessionId/transcript/export` (`exports.ts:299`) | Session transcript (md/json/jsonl)   | `redact(e.text)` per entry (`exports.ts:320`)                    |
| `GET /v1/labels/export` (`outcome-labels.ts:415`)                  | Outcome labels (json/jsonl/csv)      | `redactJson(rows.map(serializeLabel))` (`outcome-labels.ts:432`) |

The label export is the only one whose content is **human-authored free text** rather than captured
or derived data, and that is precisely why it redacts: `intent` is 200 characters somebody typed, and
may name a customer or carry a pasted credentialed URL that nothing else in the archive would have
recorded. The in-app reads (`GET /v1/sessions/:id/label`, `GET /v1/labels`) deliberately do **not**
redact — they are authenticated reads by the label's own organization, exactly like
`GET /v1/reports/:id`, whose `/export` sibling redacts while it does not.

The event export read **never decrypts** — it selects only the plaintext columns and does not touch
`payload_ciphertext`/`iv`/`tag` at all (`packages/db/src/repositories/exports.ts:5-9`). Decrypt-for-
render is the transcript path's job. The repository layer is explicit that it returns raw plaintext
including home paths, and that the **route** is contractually required to redact before responding
(`repositories/exports.ts:16-19`).

Event exports are bounded at **100,000 rows** (`repositories/exports.ts:22`), and truncation is
surfaced in the manifest and header rather than being silent.

### The data-quality audit decrypts a bounded sample, and stores none of it (M16 16.4)

`POST /v1/audit/data-quality` generates an org-scoped report artifact of the capture-quality
metrics. Only **one** of its metrics, recoverability, reads an encrypted column at all. Every other
row is derived from **plaintext metadata** — counts, timestamps, model names, connector ids,
`project_path` — and never touches one.

The seventh, **recoverability**, is the one place in the reporting layer that decrypts. It answers
"can this archive still re-derive its events from its raw records?", which cannot be answered
without reading the raw records. Concretely, per sampled session it:

1. reads that session's `raw_source_records` and **decrypts them in server memory**;
2. re-runs the same parser the collector runs at capture time;
3. compares the **fingerprint set** it produces against the fingerprint set already stored;
4. keeps four integers — `storedEvents`, `reparsedEvents`, `missing`, `extra` — and discards the
   plaintext.

Three properties bound it, and each is enforced rather than intended:

- **Bounded.** Only the sampled sessions are decrypted — 10 by default, and the request schema caps
  `sampleSize` at 50 (`apps/ingest/src/schemas.ts:330-345`). One dry run is performed per (session,
  connector, **machine**), because raw records are per-machine, so the decrypt fan-out is the sample
  times the machines holding it. It is never an archive-wide decrypt.
- **Nothing DECRYPTED is stored or rendered.** No message body, no tool payload, no file content and
  no decrypted text of any kind reaches the report, the search index or the export endpoints above —
  the recoverability rows keep four integers (`storedEvents`, `reparsedEvents`, `missing`, `extra`)
  plus the identifiers of what was checked.

  **This is not the same as saying the artifact holds only counts**, and the difference matters
  before you pair. Like every report artifact, it carries plaintext metadata: the rendered Markdown
  includes machine names, connector ids, model names, cost-confidence labels and the connector's
  **last error message** (which, per §1, may embed a home-relativized file path), and the stored
  `metrics` embeds the reconciliation sample including each sampled session's `project_path` values
  — which, per §3, may name a client, an employer or an unreleased product. Treat the audit artifact
  as exactly as sensitive as any other report you export.

- **It writes nothing at all.** `reparseDryRun` performs no insert, update or delete — it is a
  read-only twin of the M13 re-parse engine, deliberately kept separate so measuring recoverability
  cannot mutate the archive it is measuring. An integration test snapshots the `events` and
  `raw_source_records` row counts across a run and asserts both are unchanged
  (`packages/db/src/repositories/recoverability.int.test.ts:206`).

The decrypt happens **server-side only**. The browser never receives raw payloads from this path;
it receives the rendered Markdown, on the same terms as every other report artifact.

## 6. What is deleted, and how

**Read this section carefully — the answer is "almost nothing, automatically."**

**Raw records and events are never automatically deleted.** There is no retention policy, no age
based pruning, and no scheduled cleanup for `raw_source_records`, `events`, `git_commits`,
`report_artifacts` or `search_documents`. This follows from the architecture's core invariant — raw
records are immutable and permanent, everything else is a re-derivable projection — and
`scripts/backup-archive.sh:29` states it as a parenthetical: _"not DB rows — raw stays forever."_

The only automatic deletions in the system are:

| What                        | Bound                            | Where                                                       |
| --------------------------- | -------------------------------- | ----------------------------------------------------------- |
| Backup **files** (not rows) | `RETENTION_DAYS`, default **14** | `scripts/backup-archive.sh:11,29-37`                        |
| Machine heartbeat samples   | **24 hours**                     | `packages/db/src/repositories/machines.ts:11,89-93`         |
| Ingest auth-failure records | **7 days**                       | `packages/db/src/repositories/auth-failures.ts:15-16,29-30` |
| Orphaned events on re-parse | derived rows only                | `packages/db/src/repositories/reparse.ts:257-263`           |

The last one is the "events are disposable" rule in action: when a raw record is re-parsed under a
newer parser, events that no longer correspond to any fresh fingerprint are deleted and rebuilt. Raw
records are never touched by it.

**Removing a person does not remove their data.** `DELETE /v1/members/:userId` removes the
**membership** only — the `users` row deliberately survives, because an identity may belong to other
organizations and deleting it would cascade into every row referencing it
(`packages/db/src/repositories/members.ts:178-181`). Their captured sessions, events and commits
remain in the archive.

**So how do you actually delete CAPTURED data?** Directly, against your own database, with the `db:*`
scripts that authenticate via `DATABASE_URL` — the same break-glass path the operations guide
documents for administrative reads. For captured data there is **no delete-my-data button, and no
per-session delete API.** For a design partner this is the single most important sentence on this
page: deleting captured data is an operator action on a database you control, and it must be agreed
before enrolment, not after.

### Outcome labels are the one exception, and they have a written policy

M16 16.1 added the §4.3 **outcome label** — a voluntary human judgement of a session — and with it
the first delete API for **archive content** (D-16.1-6). Be precise about that scope: identity and
access objects have always been deletable (an invite, an API key, a session, a membership, an SSO
link), and none of them is captured data. What was never deletable through the API, and still is
not, is anything the collector captured:

> **A `DELETE` of an outcome label is a HARD delete of the label row and all of its revision rows,
> in one transaction. Nothing is retained, and nothing else is touched — the session's raw records,
> events, reports and search documents are unaffected.**

`DELETE /v1/sessions/:sessionId/label` (`apps/ingest/src/routes/outcome-labels.ts:273`) is that API;
the cascade is deliberately visible in code rather than hidden in DDL
(`packages/db/src/repositories/outcome-labels.ts:569-577`). Anyone at `member` or above may delete their
own label; `admin` and above may delete any label in the organization, as a data-hygiene lever.
Editing is stricter than deleting on purpose — no rung, including `owner`, may **rewrite** a label
it did not author, because retraction is not falsification.

**This does not weaken the "raw records sacred" invariant**, and the reason is the whole argument: a
label is neither raw nor derived. Raw records are permanent because they are captured evidence
nobody can recreate; events are disposable because they are re-derivable. A label is a third thing —
volunteered human ground truth — re-creatable only by the person who gave it, and therefore the one
object in the archive they are entitled to take back. Both new tables and the delete path are
asserted by two-role integration suites, including an explicit check that the session's `events` and
`raw_source_records` counts are unchanged across the whole label lifecycle.

> **Gap, stated rather than hidden.** Research plan §6 Phase 6 step 5 ("make data export, retention,
> and removal understandable and tested") still assumes a broader archive **policy** — retention and
> removal for _captured_ data — that does not exist yet. §7 P0.2's half of this gap is now closed:
> labels have a policy, stated above and implemented. Writing the captured-data policy is future
> work; this page describes what is true today.

---

## Related

- [`quickstart.md`](./quickstart.md) — the documented setup path.
- [`operations.md`](./operations.md) — backups and restore, key rotation, migration rollback,
  break-glass database access.
- [`.agents/plans/m16-dogfood-instrumentation.md`](../../.agents/plans/m16-dogfood-instrumentation.md)
  — D-M16-1 fixes which connectors are enabled during the research period.
- [`.agents/research/README.md`](../../.agents/research/README.md) — the privacy rule governing what
  may be written into the research record itself.
