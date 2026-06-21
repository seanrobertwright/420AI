import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Postgres `tsvector` is not a built-in Drizzle column type — declare it once so
 * the M12 search projection can hold a DB-GENERATED full-text vector. The app
 * never reads/writes the value directly (it is `generatedAlwaysAs` + GIN-indexed);
 * `customType` only exists so drizzle-kit emits the right column DDL.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
import type {
  NormalizedTokens,
  CostResult,
  ModelPricing,
  ConnectorCatalogPayload,
} from "@420ai/shared";

/**
 * The Central Archive schema (PRD §8.2). This is the Postgres translation of the
 * M1 SQLite store (apps/collector/src/store/sqlite-store.ts) plus the new entity
 * tables (users / machines / pairing_codes / ingest_tokens) that the pairing flow
 * and per-machine auth need.
 *
 * Column intent matches M1: raw records are sacred (verbatim, immutable), events
 * are disposable projections keyed by a machine-independent `fingerprint`.
 *
 * Field-level encryption split (PRD §18.1):
 *   - raw_source_records.payload_* and events.payload_*  → AES-256-GCM CIPHERTEXT
 *   - events.tokens / events.cost (jsonb)                → PLAINTEXT (queryable)
 *   - identity / timestamps / model / paths              → PLAINTEXT (queryable)
 * project_path/git_branch are plaintext metadata (paths, needed for project
 * attribution in M5) — they are NOT secrets.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // M12 12.3 admin login: scrypt hash of the single admin's password. NULLABLE on
  // purpose — pairing-flow users (ensureUserByEmail) have no password; only the
  // env-seeded admin (setUserPassword) gets one.
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const machines = pgTable("machines", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  os: text("os"),
  hostname: text("hostname"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // M9 Live Monitor heartbeat (PRD §20, D2). All NULLABLE — pre-M9 machines simply
  // have nulls and deriveMachineStatus falls back to lastSeenAt (D5). The collector's
  // heartbeat sets them; we store only the LATEST sample (current depth, not a trend —
  // backlog-GROWING / heartbeat history is M10, D4). No default-now: a null heartbeat
  // means "never sent one", which is distinct from "sent one at row-creation time".
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  queuePending: integer("queue_pending"),
  queueInflight: integer("queue_inflight"),
  collectorVersion: text("collector_version"),
  // M12 12.6 archive.unreachable signal — the latest collector-reported count of
  // consecutive sync failures (nullable; older collectors don't send it → null → 0).
  consecutiveSyncFailures: integer("consecutive_sync_failures"),
});

export const pairingCodes = pgTable("pairing_codes", {
  code: text("code").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ingestTokens = pgTable("ingest_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  machineId: uuid("machine_id")
    .notNull()
    .references(() => machines.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const rawSourceRecords = pgTable(
  "raw_source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    sourceConnector: text("source_connector").notNull(),
    sessionId: text("session_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    payloadCiphertext: text("payload_ciphertext").notNull(),
    payloadIv: text("payload_iv").notNull(),
    payloadTag: text("payload_tag").notNull(),
  },
  (t) => [
    // Idempotency key (PRD §23): the same source record from the same machine
    // dedups. Raw is per-machine — each machine keeps its own sacred copy.
    uniqueIndex("raw_machine_connector_record").on(
      t.machineId,
      t.sourceConnector,
      t.sourceRecordId,
    ),
    index("raw_by_session").on(t.sessionId),
  ],
);

export const events = pgTable(
  "events",
  {
    // Machine-INDEPENDENT fingerprint (PRD §12/§23): same logical event from two
    // machines dedups to one row. Do NOT add machine_id to the fingerprint.
    fingerprint: text("fingerprint").primaryKey(),
    sourceConnector: text("source_connector").notNull(),
    parserVersion: text("parser_version").notNull(),
    // Pricing-catalog version (PRD §23). NULLABLE — captured before replay-metadata
    // existed → NULL (honest); custom connector prices nothing → NULL. NOT a fingerprint input.
    catalogVersion: text("catalog_version"),
    rawRecordId: text("raw_record_id").notNull(),
    eventIndex: integer("event_index").notNull(),
    eventType: text("event_type").notNull(),
    sessionId: text("session_id").notNull(),
    // Most recent ingesting machine (events converge; raw stays per-machine).
    machineId: uuid("machine_id").references(() => machines.id),
    projectPath: text("project_path"),
    gitBranch: text("git_branch"),
    model: text("model"),
    // mode "string" keeps ISO timestamps verbatim (like M1) — no Date/TZ coercion.
    ts: timestamp("ts", { withTimezone: true, mode: "string" }).notNull(),
    tokens: jsonb("tokens").$type<NormalizedTokens>(),
    cost: jsonb("cost").$type<CostResult>(),
    // Encrypted tool-call payload (nullable — events without a payload store NULLs).
    payloadCiphertext: text("payload_ciphertext"),
    payloadIv: text("payload_iv"),
    payloadTag: text("payload_tag"),
  },
  (t) => [
    index("events_by_session").on(t.sessionId, t.ts),
    // M5 attribution join: projectEventSummary joins events.project_path →
    // workspace_keys.project_key. Indexed so per-project summaries don't seq-scan
    // events. Additive (no column/shape change — the fingerprint is untouched).
    index("events_by_project_path").on(t.projectPath),
  ],
);

/**
 * M5 project / workspace mapping (PRD §6, §19). These three tables give the flat
 * event stream structure WITHOUT touching `events`: attribution is a JOIN
 * (events.project_path → workspace_keys.project_key → workspaces.project_id),
 * never a column on events (event-sourcing discipline — re-derivable projections).
 */

/**
 * A software effort. Cross-machine identity is by `git_remote` (nullable): the
 * same repo on two machines (two different absolute paths) unifies to ONE
 * project. NOTE: Postgres treats NULLs as distinct in a UNIQUE index, so two
 * remote-less (folder-named) projects are intentionally NOT unified.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    gitRemote: text("git_remote"), // natural key for unify-by-remote (nullable)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("projects_user_remote").on(t.userId, t.gitRemote)],
);

/**
 * A local dev context where sessions occurred (PRD §6). One per (user, root_path).
 * `project_id` is nullable until mapped (auto-mapped on discover); `root_path` is
 * the resolved real path (Claude/Codex cwd, or the Gemini `.project_root` value).
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    projectId: uuid("project_id").references(() => projects.id),
    machineId: uuid("machine_id").references(() => machines.id),
    rootPath: text("root_path").notNull(),
    gitRemote: text("git_remote"),
    gitBranch: text("git_branch"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspaces_user_root").on(t.userId, t.rootPath),
    index("workspaces_by_project").on(t.projectId),
  ],
);

/**
 * Maps the RAW `events.project_path` string (real path for Claude/Codex, the
 * Gemini `projectHash` for Gemini) to a workspace. This alias table is what
 * bridges the path/hash mismatch at attribution time. The join key is global per
 * user (an event row has no user_id), so `project_key` is unique per (user, key)
 * — `user_id` is carried HERE so the uniqueness + scoping are both correct.
 */
export const workspaceKeys = pgTable(
  "workspace_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sourceConnector: text("source_connector").notNull(),
    projectKey: text("project_key").notNull(), // == events.project_path as emitted by the connector
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_keys_user_key").on(t.userId, t.projectKey),
    index("workspace_keys_by_workspace").on(t.workspaceId),
  ],
);

/**
 * M7 Reporting Foundation (PRD §15, §16.1, §23). A durable, versioned Markdown
 * report artifact rendered from the M6 deterministic projections. Regenerating a
 * report for the same (user, report_type, scope) appends a NEW row with
 * `version = max(version)+1` — prior artifacts are retained (the §23 history).
 *
 * PLAINTEXT storage (D3 / PRD §18.1): the rendered `markdown` + the `metrics`
 * snapshot contain only derived metrics (counts/tokens/cost/model/paths/
 * timestamps) — none of the §18.1 encrypt-list — so there are NO `payload_*`
 * columns; both are stored as plaintext. The artifact row IS the record of a
 * generated report (NOT a `report.generated` event — Scope Decision 2).
 */
export const reportArtifacts = pgTable(
  "report_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // Project-scoped reports set project_id; session-scoped reports leave it null.
    projectId: uuid("project_id").references(() => projects.id),
    reportType: text("report_type").notNull(), // ReportType ("project.cost_over_time" | "session.autopsy")
    scopeKind: text("scope_kind").notNull(), // "project" | "session"
    scopeId: text("scope_id").notNull(), // project uuid (as text) OR connector session_id (text)
    version: integer("version").notNull(), // 1-based; bumps per (user, report_type, scope_id)
    reportVersion: text("report_version").notNull(), // REPORT_VERSION (renderer identity, PRD §23)
    // §23 replay metadata (NULLABLE, additive). catalog_version: pricing catalog the
    // cost metrics were rendered under; analysis_version: AI Interpretation Pipeline
    // identity (AI artifacts only; deterministic reports leave it NULL).
    catalogVersion: text("catalog_version"),
    analysisVersion: text("analysis_version"),
    params: jsonb("params"), // generation params, e.g. {bucket:"day"} (reproducibility)
    metrics: jsonb("metrics").notNull(), // snapshot of the projection JSON rendered (replay/compare seam)
    markdown: text("markdown").notNull(), // the rendered report (plaintext — derived metrics only)
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // History lookup + the version-bump backstop (one row per (user, type, scope, version)).
    uniqueIndex("report_artifacts_scope_version").on(t.userId, t.reportType, t.scopeId, t.version),
    index("report_artifacts_by_scope").on(t.userId, t.reportType, t.scopeId),
  ],
);

/**
 * M10 Git Outcomes (PRD §11.3, §18.1, §23). A captured git commit per repository.
 * DEDICATED table (NOT `events` rows — D2), mirroring `report_artifacts`: the row
 * IS the record of a commit. Encryption split (D4): the commit MESSAGE is
 * encrypted (a "message body" per §18.1); author name/email, branch, changed-file
 * paths and numstat counts stay PLAINTEXT (git metadata, same class as the
 * already-plaintext `project_path`) so attribution + reports query them WITHOUT
 * decrypting. Full patch text is deferred (§11.3 marks Git Diff Capture optional).
 *
 * The commit SHA is git's own content hash → the idempotency key (D3): a re-scan
 * `ON CONFLICT (machine_id, commit_sha) DO NOTHING` is a no-op, like the event
 * fingerprint but with zero new fingerprint code. `repo_root_path` is the join key
 * == `events.project_path` (attribution maps it via `workspace_keys`).
 */
export const gitCommits = pgTable(
  "git_commits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    commitSha: text("commit_sha").notNull(),
    repoRootPath: text("repo_root_path").notNull(), // == events.project_path (the attribution join key)
    gitBranch: text("git_branch"),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    // mode "string" keeps the ISO timestamp verbatim (offset OR Z form) — no Date/TZ coercion.
    authoredAt: timestamp("authored_at", { withTimezone: true, mode: "string" }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "string" }),
    parents: text("parents"), // space-joined parent SHAs (2+ ⇒ a merge commit)
    isRevert: boolean("is_revert").notNull().default(false),
    filesChanged: integer("files_changed").notNull(),
    insertions: integer("insertions").notNull(),
    deletions: integer("deletions").notNull(),
    // Encrypted commit message (§18.1) — nullable (an empty body is normal).
    messageCiphertext: text("message_ciphertext"),
    messageIv: text("message_iv"),
    messageTag: text("message_tag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency key (D3 / PRD §23): the same commit from the same machine dedups.
    uniqueIndex("git_commits_machine_sha").on(t.machineId, t.commitSha),
    // Attribution + project join: resolve commits for a repo root (== project_path).
    index("git_commits_by_root").on(t.repoRootPath),
  ],
);

/**
 * M10 per-commit changed file (the `--numstat` rows). PLAINTEXT path + line counts
 * (patch text is deferred per §11.3). Binary files store 0/0 (numstat `-`/`-`).
 */
export const gitCommitFiles = pgTable(
  "git_commit_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commitId: uuid("commit_id")
      .notNull()
      .references(() => gitCommits.id),
    filePath: text("file_path").notNull(), // repo-relative (e.g. src/x.ts)
    status: text("status").notNull(), // "added" | "modified" | "deleted" | "renamed"
    insertions: integer("insertions").notNull(),
    deletions: integer("deletions").notNull(),
  },
  (t) => [index("git_commit_files_by_commit").on(t.commitId)],
);

/**
 * M10 Outcome Attribution (PRD §11.4, D5). The session→commit link side-table:
 * attribution is a JOIN/side-table, NEVER a column on `events` or `git_commits`.
 * A link ALWAYS carries a `confidence` + `status` — a suggestion is never a fact.
 *
 * `(user_id, session_id, commit_id)` is unique so a re-suggest is idempotent and a
 * manual confirm upserts the SAME row (D6 — the suggest path refreshes metrics for
 * `suggested` rows but never clobbers a human `confirmed`/`rejected`).
 */
export const sessionGitLinks = pgTable(
  "session_git_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sessionId: text("session_id").notNull(),
    commitId: uuid("commit_id")
      .notNull()
      .references(() => gitCommits.id),
    projectId: uuid("project_id").references(() => projects.id),
    confidence: text("confidence").notNull(), // AttributionConfidence
    status: text("status").notNull(), // "suggested" | "confirmed" | "rejected"
    minutesDelta: integer("minutes_delta"),
    fileOverlap: integer("file_overlap").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("session_git_links_unique").on(t.userId, t.sessionId, t.commitId),
    index("session_git_links_by_commit").on(t.commitId),
  ],
);

/**
 * M10 3c heartbeat time-series (PRD §20). Append-only sync-backlog samples so
 * "backlog GROWING" is a real trend (the machines row keeps only the LATEST
 * sample — schema comment above). recordHeartbeat appends here + prunes beyond
 * HEARTBEAT_RETENTION_MS. Plain timestamptz (Date) → normalize to ISO on read.
 */
export const machineHeartbeats = pgTable(
  "machine_heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    queuePending: integer("queue_pending").notNull(),
    queueInflight: integer("queue_inflight").notNull(),
  },
  (t) => [index("machine_heartbeats_by_machine_ts").on(t.machineId, t.ts)],
);

/**
 * M12 12.6 ingest auth-failure audit (PRD §20). Append-only; recordIngestAuthFailure
 * appends + prunes. GLOBAL (no user_id — the token never resolved to a machine/user).
 * Feeds the windowed `ingest.auth_failure` alert via countRecentAuthFailures.
 */
export const ingestAuthFailures = pgTable(
  "ingest_auth_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    remoteIp: text("remote_ip"),
  },
  (t) => [index("ingest_auth_failures_by_ts").on(t.ts)],
);

/**
 * M10 3c persisted Operational-Alert firings (PRD §20). Evaluate-on-read
 * reconcile (D1) upserts ONE open firing per (user, alert_key) — the PARTIAL
 * unique index below is the idempotency backbone (D3). first_fired_at records
 * when the firing opened (the stateless deriveAlerts could not). `since` is an
 * opaque ISO display label (text — never compared temporally).
 */
export const alertFirings = pgTable(
  "alert_firings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    alertKey: text("alert_key").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    machineId: uuid("machine_id").references(() => machines.id),
    machineName: text("machine_name"),
    connector: text("connector"),
    since: text("since"),
    status: text("status").notNull().default("open"),
    firstFiredAt: timestamp("first_fired_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    // M12 12.6 alert delivery: at-most-one delivery ATTEMPT per firing — stamped on
    // success OR failure by deliverPendingFirings (nullable; null = not yet attempted).
    deliveryAttemptedAt: timestamp("delivery_attempted_at", { withTimezone: true }),
  },
  (t) => [
    // At most ONE open firing per (user, alert_key) — the reconcile idempotency key (D3).
    uniqueIndex("alert_firings_open_key")
      .on(t.userId, t.alertKey)
      .where(sql`${t.status} = 'open'`),
    index("alert_firings_by_user_status").on(t.userId, t.status),
  ],
);

/**
 * M10 3d signed pricing-catalog updates (PRD §10.4/§18/§20/§23). A catalog uploaded
 * via POST /v1/catalog after ed25519 signature verify, held `pending` until an admin
 * approves it → `active` (the prior active is `superseded`). The PARTIAL unique index
 * enforces ≤1 active (mirrors alert_firings_open_key). GLOBAL (no user_id) — pricing
 * applies to everyone. `payload` is the model→ModelPricing map (the signed content);
 * an active row re-prices ingests going forward (cost computed server-side at ingest).
 * `version` is unique so a re-upload of the same version is an idempotent no-op (D6).
 */
export const pricingCatalogs = pgTable(
  "pricing_catalogs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: text("version").notNull(), // self-declared catalog version (e.g. "m10-catalog-v2")
    payload: jsonb("payload").$type<Record<string, ModelPricing>>().notNull(),
    signature: text("signature").notNull(), // base64 ed25519 over canonicalizeCatalog({version,payload})
    status: text("status").notNull().default("pending"), // "pending" | "active" | "superseded" | "rejected"
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
  },
  (t) => [
    uniqueIndex("pricing_catalogs_version").on(t.version), // idempotent upload (re-upload same version = no-op)
    uniqueIndex("pricing_catalogs_one_active")
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * M12 12.7c signed CONNECTOR-catalog updates (PRD §10.4). The structural twin of
 * `pricing_catalogs`: a catalog uploaded via POST /v1/connector-catalog after ed25519
 * signature verify, held `pending` until an admin approves it → `active` (the prior
 * active is `superseded`). The PARTIAL unique index enforces ≤1 active (copied verbatim
 * from pricing_catalogs_one_active). GLOBAL (no user_id) — connector definitions apply
 * to every machine. `payload` is the ConnectorCatalogPayload (per-connector
 * metadata/location overlays + data-only defs — the signed content). The collector pulls
 * the active row via GET /v1/connector-catalog/active and overlays it onto the registry.
 * `version` is unique so a re-upload of the same version is an idempotent no-op.
 */
export const connectorCatalogs = pgTable(
  "connector_catalogs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: text("version").notNull(), // self-declared catalog version (e.g. "m12-connector-catalog-v2")
    payload: jsonb("payload").$type<ConnectorCatalogPayload>().notNull(),
    signature: text("signature").notNull(), // base64 ed25519 over canonicalizeCatalog({version,payload})
    status: text("status").notNull().default("pending"), // "pending" | "active" | "superseded" | "rejected"
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
  },
  (t) => [
    uniqueIndex("connector_catalogs_version").on(t.version), // idempotent upload (re-upload same version = no-op)
    uniqueIndex("connector_catalogs_one_active")
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * M12 §21 redacted search projection (PRD §18.1/§21). Every row's `title`/`body`
 * is ALREADY redacted (REDACTION_VERSION stamped) — we NEVER index encrypted
 * originals. `search_vector` is DB-GENERATED from title (weight A) + body
 * (weight B) and GIN-indexed; the app never writes it (inserting it errors).
 *
 * A DISPOSABLE projection: rebuilt wholesale by `rebuildSearchIndex()` (delete-
 * then-insert from reports + projects + sessions), never a source of truth —
 * consistent with "raw sacred, projections disposable". The unique index on
 * (entity_type, entity_id) makes a re-reindex idempotent.
 */
export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    entityType: text("entity_type").notNull(), // 'session' | 'report' | 'project'
    entityId: text("entity_id").notNull(), // sessionId (text) | report uuid | project uuid
    projectId: uuid("project_id"), // nullable filter key (unattributed sessions → null)
    title: text("title"),
    body: text("body").notNull(),
    redactionVersion: text("redaction_version").notNull(), // REDACTION_VERSION stamp (§23)
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    // DB-maintained: recomputed from title (A) + body (B) on every write. NEVER inserted.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')`,
    ),
  },
  (t) => [
    // One doc per logical entity — the re-reindex idempotency key.
    uniqueIndex("search_documents_entity").on(t.entityType, t.entityId),
    index("search_documents_gin").using("gin", t.searchVector),
    index("search_documents_by_project").on(t.projectId),
  ],
);
