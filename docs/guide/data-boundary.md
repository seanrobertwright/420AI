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
original. Exports are redacted before bytes leave the archive. **Nothing is ever deleted
automatically** — see §6, which is the section most likely to surprise you.

---

## 1. What is captured

Capture is per-connector, and a connector reads **only** the paths its declared capture scope names.
Those declarations are the "Capture Permission" you review, and widening one is a **Capture Surface
Change** that requires fresh approval before it captures again
(`apps/collector/src/connectors/connector.ts:38-46`).

Connectors enabled for the current research period (`.agents/plans/m16-dogfood-instrumentation.md`,
D-M16-1) and what each declares:

| Connector       | Declared capture scope (`requiredPermissions`)                                                            | Liveness  | Tokens | Cost     |
| --------------- | --------------------------------------------------------------------------------------------------------- | --------- | ------ | -------- |
| **Claude Code** | Read Claude Code session transcripts under `~/.claude/projects/*/*.jsonl` (`claude-code.ts:94-96`)        | streaming | exact  | computed |
| **Codex CLI**   | Read OpenAI Codex CLI rollout logs under `~/.codex/sessions/*/*/*/rollout-*.jsonl` (`codex-cli.ts:92-94`) | streaming | exact  | computed |

Other connectors exist in the registry (`connectors/connector.ts:1-9` imports Gemini CLI, Cursor,
and the Claude/ChatGPT/Gemini export + `claude-live` connectors) and are **not enabled** for this
period. A connector that is not enabled reads nothing.

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
- `git_commits.message_ciphertext` (`schema.ts:717`) — the commit **message** only.

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

Three export surfaces, all authenticated, all redacted before the bytes leave the archive
(`apps/ingest/src/routes/exports.ts:33`):

| Endpoint                                                           | Content                              | Redaction                                     |
| ------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------- |
| `GET /v1/exports/events` (`exports.ts:150`)                        | Event stream, plaintext columns only | `redactJson(rows)` (`exports.ts:193`)         |
| `GET /v1/reports/:id/export` (`exports.ts:232`)                    | A rendered report artifact (md/json) | `redactJson(…)` (`exports.ts:252`)            |
| `GET /v1/sessions/:sessionId/transcript/export` (`exports.ts:299`) | Session transcript (md/json/jsonl)   | `redact(e.text)` per entry (`exports.ts:320`) |

The event export read **never decrypts** — it selects only the plaintext columns and does not touch
`payload_ciphertext`/`iv`/`tag` at all (`packages/db/src/repositories/exports.ts:5-9`). Decrypt-for-
render is the transcript path's job. The repository layer is explicit that it returns raw plaintext
including home paths, and that the **route** is contractually required to redact before responding
(`repositories/exports.ts:16-19`).

Event exports are bounded at **100,000 rows** (`repositories/exports.ts:23`), and truncation is
surfaced in the manifest and header rather than being silent.

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

**So how do you actually delete something?** Directly, against your own database, with the `db:*`
scripts that authenticate via `DATABASE_URL` — the same break-glass path the operations guide
documents for administrative reads. There is **no delete-my-data button, and no per-session delete
API.** For a design partner this is the single most important sentence on this page: deletion is an
operator action on a database you control, and it must be agreed before enrolment, not after.

> **Gap, stated rather than hidden.** Research plan §6 Phase 6 step 5 ("make data export, retention,
> and removal understandable and tested") and §7 P0.2's acceptance criterion (a label can be
> "deleted according to archive policy") both assume an archive **policy** that does not exist yet.
> Writing one is future work; this page describes what is true today.

---

## Related

- [`quickstart.md`](./quickstart.md) — the documented setup path.
- [`operations.md`](./operations.md) — backups and restore, key rotation, migration rollback,
  break-glass database access.
- [`.agents/plans/m16-dogfood-instrumentation.md`](../../.agents/plans/m16-dogfood-instrumentation.md)
  — D-M16-1 fixes which connectors are enabled during the research period.
- [`.agents/research/README.md`](../../.agents/research/README.md) — the privacy rule governing what
  may be written into the research record itself.
