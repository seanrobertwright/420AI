-- M15 15.3 RLS enforcement (D-M15-3 backstop; D-15.3-1/D-15.3-3/D-15.3-4). HAND-AUTHORED —
-- `drizzle-kit generate` cannot emit CREATE ROLE, GRANT, ALTER DEFAULT PRIVILEGES or
-- CREATE POLICY, so none of this slice's DDL is expressible in the schema file. Mirrors
-- 0014's hand-edited convention.
--
-- WHY A SEPARATE ROLE AT ALL: RLS is INERT against a superuser / a role with `rolbypassrls`,
-- which is what `DATABASE_URL` connects as. `FORCE ROW LEVEL SECURITY` removes only the
-- table-OWNER exemption — a DIFFERENT exemption with a DIFFERENT switch (15.0 Finding 1).
-- So policies alone change nothing; the non-owner `420ai_app` role is load-bearing.
--
-- Order matters: create the role FIRST (NOLOGIN — `db:provision-app-role` grants LOGIN and
-- sets the password, so the migration never touches a secret), then grant, then policy. That
-- makes the migration self-sufficient whether or not the provisioning CLI has run.
--
-- THE `nullif(..., '')` GUARD IS MANDATORY, not defensive styling: `current_setting(x, true)`
-- returns '' (not NULL) when the setting was never set in this transaction, and `''::uuid`
-- raises `invalid input syntax for type uuid`. Without the guard an unset context turns every
-- query into a 500 instead of an empty result — a backstop must fail closed and QUIET.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '420ai_app') THEN CREATE ROLE "420ai_app" NOLOGIN; END IF; END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "420ai_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "420ai_app";--> statement-breakpoint
-- Without this, EVERY FUTURE MIGRATION'S new table is unreadable by the app role — a
-- time-bomb that would surface in a later slice, not here. No `FOR ROLE` clause on purpose:
-- it then applies to objects created by the role running THIS migration (`420ai`, the owner),
-- which is exactly who runs every future migration. Naming a different role silently no-ops.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "420ai_app";--> statement-breakpoint

-- ============================================================================
-- STRICT policies (12 tables): unset context => 0 rows. These hold tenant content.
-- A USING-only policy is applied as the WITH CHECK when the latter is omitted, which is what
-- also blocks cross-tenant INSERT/UPDATE (Spike 6: today a converging cross-org upsert
-- SILENTLY overwrites the other org's row — D-M15-2's `set:`-block omission protects only the
-- `org_id` column, not `parser_version` / `tokens` / `cost` / `machine_id`).
-- ============================================================================
ALTER TABLE "raw_source_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "raw_source_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "raw_source_records_org_isolation" ON "raw_source_records" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "events_org_isolation" ON "events" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "projects_org_isolation" ON "projects" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspaces_org_isolation" ON "workspaces" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "workspace_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_keys_org_isolation" ON "workspace_keys" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "report_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_artifacts_org_isolation" ON "report_artifacts" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "git_commits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_commits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "git_commits_org_isolation" ON "git_commits" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "git_commit_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_commit_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "git_commit_files_org_isolation" ON "git_commit_files" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "session_git_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_git_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "session_git_links_org_isolation" ON "session_git_links" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "machine_heartbeats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "machine_heartbeats_org_isolation" ON "machine_heartbeats" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "alert_firings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_firings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "alert_firings_org_isolation" ON "alert_firings" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "search_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "search_documents_org_isolation" ON "search_documents" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint

-- ============================================================================
-- BOOTSTRAP-PERMISSIVE policies (3 tables, D-15.3-3): enforced when a context IS set,
-- permissive when it is not. The credential lookup that DISCOVERS the org must itself be able
-- to run: `findMachineIdByToken` reads ingest_tokens -> machines IN ORDER TO learn the org, and
-- `redeemPairingCode` runs before any principal exists. A strict policy here 401s every
-- collector. This is a STRICT IMPROVEMENT over no RLS (which is open always): inside a
-- `withOrg` block it enforces; outside it behaves as today. Pinned by rls.int.test.ts so the
-- exemption cannot silently grow.
-- ============================================================================
ALTER TABLE "machines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "machines_org_isolation" ON "machines" USING (nullif(current_setting('app.current_org', true), '') IS NULL OR org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ingest_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ingest_tokens_org_isolation" ON "ingest_tokens" USING (nullif(current_setting('app.current_org', true), '') IS NULL OR org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pairing_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pairing_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pairing_codes_org_isolation" ON "pairing_codes" USING (nullif(current_setting('app.current_org', true), '') IS NULL OR org_id = nullif(current_setting('app.current_org', true), '')::uuid);
-- NO RLS on `users`, `organizations`, `memberships` (D-15.3-4): these are the identity tables
-- `resolvePrincipal` reads to ESTABLISH the org — the same circularity as above, with no
-- bootstrap-permissive middle ground worth the complexity. They carry no tenant content.
-- NO RLS on `pricing_catalogs`, `connector_catalogs`, `ingest_auth_failures`: deployment-global
-- per D-M15-9 (they have no `org_id` column at all).
