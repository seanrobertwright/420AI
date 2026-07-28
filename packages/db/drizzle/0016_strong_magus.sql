-- M15 15.4 RBAC (D-M15-4; D-15.4-2/D-15.4-3). HAND-EDITED on top of the drizzle-generated
-- `project_grants` DDL — `drizzle-kit generate` cannot emit CREATE POLICY or GRANT, so the
-- entire authorization backstop below is hand-authored. Mirrors 0014/0015's convention.
--
-- Two things ship here:
--   (1) `project_grants` — per-project capability ELEVATION (D-15.4-2). Grants ADD capability,
--       never restrict it, so this table is EMPTY in a solo install and 15.4 is byte-identical
--       to 15.3 there (D-M15-10). It is a new TENANT table, so it gets the same strict org
--       policy as the other 12.
--   (2) The ROLE WRITE BACKSTOP — 39 RESTRICTIVE policies (13 tables x 3 commands).
--
-- WHY RESTRICTIVE: Postgres combines RESTRICTIVE policies with AND and PERMISSIVE ones with OR.
-- These therefore AND with the 15.3 org policies rather than replacing them — THE 15 EXISTING
-- POLICIES ARE NOT TOUCHED BY THIS MIGRATION AT ALL, so the tenancy layer 0015 proved is intact
-- by construction, not by re-verification.
--
-- WHY THREE POLICIES PER TABLE, not one: Postgres treats the write commands differently and
-- Spike 1 measured exactly how.
--   INSERT -> WITH CHECK  -> raises "new row violates row-level security policy" (LOUD)
--   UPDATE -> WITH CHECK  -> also LOUD. Putting the role test in USING instead would silently
--                            report "UPDATE 0" (Spike 1) — a far worse failure to debug, and
--                            Spike 1b confirmed WITH CHECK flips it to an error.
--   DELETE -> USING only  -> Postgres has NO WITH CHECK for DELETE, so a blocked delete is
--                            unavoidably a silent "DELETE 0". The ROUTE gate is the loud layer;
--                            this is only the backstop. Do not try to make it loud — there is
--                            no mechanism. rbac.int.test.ts asserts the silence explicitly so
--                            nobody later "fixes" it into an expectation Postgres cannot meet.
--
-- NO restrictive policy FOR SELECT, on purpose (D-15.4-3): a viewer is entitled to READ their own
-- org, so a role predicate on SELECT buys nothing the org policy does not already give, while
-- making every read more expensive.
--
-- NO restrictive policy on the 3 BOOTSTRAP tables (`machines`, `ingest_tokens`, `pairing_codes`)
-- for the same reason 0015 made them bootstrap-permissive: they are written by machine/bootstrap
-- paths that have no principal and therefore no membership role.
--
-- THE coalesce DEFAULT IS 'member', i.e. PERMISSIVE, and that is deliberate. `current_setting(x,
-- true)` returns '' when unset (same trap 0015's nullif guard exists for). Machine-authed writes
-- and the deployment-wide maintenance ops pass SERVICE_ROLE; a context with NO role at all must
-- still write, or every collector ingest 500s. Failing closed here would be failing closed on the
-- wrong axis — the route gate is where a missing role is a refusal.
CREATE TABLE "project_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_grants_project_user" ON "project_grants" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_grants_by_org" ON "project_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "project_grants_by_user" ON "project_grants" USING btree ("user_id");--> statement-breakpoint
-- `project_grants` is a new TENANT table: same strict org policy as the other 12 (0015 style).
ALTER TABLE "project_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "project_grants_org_isolation" ON "project_grants" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
-- 0015's `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` (no FOR ROLE clause) already covers a table
-- created by the migration owner, so this GRANT is redundant. It is here anyway as belt-and-braces:
-- 0015's own comment calls the default-privileges mechanism "a time-bomb that would surface in a
-- later slice" — this is that later slice, and an idempotent assertion costs nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "project_grants" TO "420ai_app";--> statement-breakpoint

-- ============================================================================
-- ROLE WRITE BACKSTOP — 39 RESTRICTIVE policies (13 tables x INSERT/UPDATE/DELETE).
-- ============================================================================
CREATE POLICY "raw_source_records_role_write_ins" ON "raw_source_records" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "raw_source_records_role_write_upd" ON "raw_source_records" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "raw_source_records_role_write_del" ON "raw_source_records" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "events_role_write_ins" ON "events" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "events_role_write_upd" ON "events" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "events_role_write_del" ON "events" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "projects_role_write_ins" ON "projects" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "projects_role_write_upd" ON "projects" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "projects_role_write_del" ON "projects" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "workspaces_role_write_ins" ON "workspaces" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "workspaces_role_write_upd" ON "workspaces" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "workspaces_role_write_del" ON "workspaces" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "workspace_keys_role_write_ins" ON "workspace_keys" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "workspace_keys_role_write_upd" ON "workspace_keys" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "workspace_keys_role_write_del" ON "workspace_keys" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "report_artifacts_role_write_ins" ON "report_artifacts" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "report_artifacts_role_write_upd" ON "report_artifacts" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "report_artifacts_role_write_del" ON "report_artifacts" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "git_commits_role_write_ins" ON "git_commits" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "git_commits_role_write_upd" ON "git_commits" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "git_commits_role_write_del" ON "git_commits" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "git_commit_files_role_write_ins" ON "git_commit_files" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "git_commit_files_role_write_upd" ON "git_commit_files" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "git_commit_files_role_write_del" ON "git_commit_files" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "session_git_links_role_write_ins" ON "session_git_links" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "session_git_links_role_write_upd" ON "session_git_links" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "session_git_links_role_write_del" ON "session_git_links" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "machine_heartbeats_role_write_ins" ON "machine_heartbeats" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "machine_heartbeats_role_write_upd" ON "machine_heartbeats" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "machine_heartbeats_role_write_del" ON "machine_heartbeats" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "alert_firings_role_write_ins" ON "alert_firings" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "alert_firings_role_write_upd" ON "alert_firings" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "alert_firings_role_write_del" ON "alert_firings" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "search_documents_role_write_ins" ON "search_documents" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "search_documents_role_write_upd" ON "search_documents" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "search_documents_role_write_del" ON "search_documents" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "project_grants_role_write_ins" ON "project_grants" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "project_grants_role_write_upd" ON "project_grants" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "project_grants_role_write_del" ON "project_grants" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');
