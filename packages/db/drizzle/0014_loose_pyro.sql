-- M15 15.1 tenancy (D-M15-1/D-M15-2/D-M15-11). HAND-EDITED after `drizzle-kit generate`:
-- drizzle emits `ALTER TABLE ... ADD COLUMN "org_id" uuid NOT NULL`, which FAILS on a
-- populated table (`column "org_id" of relation "events" contains null values`), and it
-- cannot emit a data backfill. Sequence instead:
--   add nullable (metadata-only) -> seed one personal org per user -> backfill along the
--   ownership chain -> SET NOT NULL -> FKs -> indexes -> re-scope the search unique index.
-- The FK/index statements below are drizzle's own output, unmodified.
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Audit B.1: `search_documents_entity` was GLOBALLY unique on (entity_type, entity_id),
-- and for session/event rows entity_id is a connector session id / event fingerprint —
-- a globally-scoped string two orgs could collide on. Dropped here (before the backfill)
-- and recreated org-scoped as the LAST statement of this migration.
DROP INDEX "search_documents_entity";--> statement-breakpoint

-- STEP 1: add org_id NULLABLE to the 15 tenant tables. A nullable ADD COLUMN with no
-- default is metadata-only in PG 11+ — no table rewrite, instant even on 413k events.
-- Deliberately NOT added to: users (an identity, not tenant data — it reaches orgs via
-- memberships), pricing_catalogs / connector_catalogs (global per D-M15-9), and
-- ingest_auth_failures (documented global — the token never resolved to a machine).
ALTER TABLE "machines" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "git_commit_files" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "session_git_links" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "alert_firings" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "org_id" uuid;--> statement-breakpoint

-- STEP 2: one PERSONAL org per existing user; that user is its `owner` (D-M15-11).
-- The join back on email is exact because users.email is UNIQUE and the org name is
-- seeded from it; this is the ONLY statement where an org's name is load-bearing.
WITH new_orgs AS (
  INSERT INTO "organizations" ("name", "is_personal")
  SELECT u.email, true FROM "users" u
  RETURNING "id", "name"
)
INSERT INTO "memberships" ("org_id", "user_id", "role")
SELECT o.id, u.id, 'owner' FROM new_orgs o JOIN "users" u ON u.email = o.name;--> statement-breakpoint

-- STEP 3: backfill along the ownership chain. `machines` FIRST — it is the source for
-- every machine-keyed table below. User-keyed tables resolve through `memberships`;
-- git_commit_files inherits from its parent commit.
UPDATE "machines" m SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = m."user_id";--> statement-breakpoint
UPDATE "pairing_codes" p SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = p."user_id";--> statement-breakpoint
UPDATE "projects" p SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = p."user_id";--> statement-breakpoint
UPDATE "workspaces" w SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = w."user_id";--> statement-breakpoint
UPDATE "workspace_keys" k SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = k."user_id";--> statement-breakpoint
UPDATE "report_artifacts" r SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = r."user_id";--> statement-breakpoint
UPDATE "session_git_links" l SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = l."user_id";--> statement-breakpoint
UPDATE "alert_firings" a SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = a."user_id";--> statement-breakpoint
UPDATE "search_documents" s SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = s."user_id";--> statement-breakpoint
UPDATE "ingest_tokens" t SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = t."machine_id";--> statement-breakpoint
UPDATE "raw_source_records" r SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = r."machine_id";--> statement-breakpoint
UPDATE "machine_heartbeats" h SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = h."machine_id";--> statement-breakpoint
UPDATE "git_commits" g SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = g."machine_id";--> statement-breakpoint
UPDATE "events" e SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = e."machine_id";--> statement-breakpoint
UPDATE "git_commit_files" f SET "org_id" = g."org_id" FROM "git_commits" g WHERE g."id" = f."commit_id";--> statement-breakpoint

-- STEP 3b: deterministic fallback for a broken chain. `events.machine_id` is NULLABLE by
-- design ("most recent ingesting machine"), and a search_documents row can outlive the
-- rows it was built from. Oldest org wins, ordered (created_at, id) so it is stable.
-- On the real 413,765-event archive this matched ZERO rows — it exists so the SET NOT
-- NULL below can never fail on an install whose chain IS broken.
UPDATE "events" SET "org_id" = (SELECT "id" FROM "organizations" ORDER BY "created_at","id" LIMIT 1) WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "search_documents" SET "org_id" = (SELECT "id" FROM "organizations" ORDER BY "created_at","id" LIMIT 1) WHERE "org_id" IS NULL;--> statement-breakpoint

-- STEP 4: enforce NOT NULL, now that every row is populated.
ALTER TABLE "machines" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pairing_codes" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_source_records" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_keys" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_artifacts" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "git_commits" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "git_commit_files" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "session_git_links" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_firings" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- STEP 5-7: drizzle's own FK / index output, verbatim.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_by_user" ON "memberships" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "alert_firings" ADD CONSTRAINT "alert_firings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commit_files" ADD CONSTRAINT "git_commit_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commits" ADD CONSTRAINT "git_commits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD CONSTRAINT "ingest_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" ADD CONSTRAINT "machine_heartbeats_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD CONSTRAINT "raw_source_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_git_links" ADD CONSTRAINT "session_git_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_firings_by_org" ON "alert_firings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "events_by_org" ON "events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "git_commit_files_by_org" ON "git_commit_files" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "git_commits_by_org" ON "git_commits" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ingest_tokens_by_org" ON "ingest_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "machine_heartbeats_by_org" ON "machine_heartbeats" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "machines_by_org" ON "machines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pairing_codes_by_org" ON "pairing_codes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "projects_by_org" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "raw_source_records_by_org" ON "raw_source_records" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "report_artifacts_by_org" ON "report_artifacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "session_git_links_by_org" ON "session_git_links" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_keys_by_org" ON "workspace_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "workspaces_by_org" ON "workspaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_entity" ON "search_documents" USING btree ("org_id","entity_type","entity_id");
