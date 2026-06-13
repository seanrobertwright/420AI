import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { NormalizedTokens, CostResult } from "@420ai/shared";

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
  (t) => [index("events_by_session").on(t.sessionId, t.ts)],
);
