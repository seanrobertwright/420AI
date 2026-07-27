-- Down-migration for 0016_strong_magus (M15 15.4). Reverses the RBAC layer: drops the 39
-- RESTRICTIVE role-write policies, then `project_grants` (its org policy, its RLS switches and
-- the table itself).
--
-- ORDERING DISCIPLINE, mirroring 0015's down: every POLICY is dropped before any table's RLS is
-- disabled or any table is dropped. Dropping a policy while RLS stays ENABLED is the state that
-- makes Postgres deny everything (the 15.3 corollary in CLAUDE.md) — harmless here because we go
-- on to disable RLS on `project_grants` and because the other 12 tables keep their 0015
-- permissive org policies, which is exactly the pre-15.4 state.
--
-- The 15 policies 0015 created are DELIBERATELY UNTOUCHED. 0016 never modified them (restrictive
-- policies AND with permissive ones rather than replacing them), so reversing 0016 must not
-- either. Rolling back tenancy is 0015's down.
--
-- WARNING: this removes the ROLE write backstop. The route-layer gate (`authorized()`) survives
-- and is the PRIMARY defence — but after this rollback a missed route gate is once again an
-- unguarded write.
--
-- D-M15-13 rollback-drill note: unlike 0014, this down drops no column carrying data.
-- `project_grants` is EMPTY in a solo install (grants only ELEVATE, so nobody needs a row), so
-- the drill is cheap. In a multi-user install it DOES discard grant rows — capability falls back
-- to the org membership role, which is a demotion, never an escalation.
DROP POLICY IF EXISTS "raw_source_records_role_write_ins" ON "raw_source_records";--> statement-breakpoint
DROP POLICY IF EXISTS "raw_source_records_role_write_upd" ON "raw_source_records";--> statement-breakpoint
DROP POLICY IF EXISTS "raw_source_records_role_write_del" ON "raw_source_records";--> statement-breakpoint
DROP POLICY IF EXISTS "events_role_write_ins" ON "events";--> statement-breakpoint
DROP POLICY IF EXISTS "events_role_write_upd" ON "events";--> statement-breakpoint
DROP POLICY IF EXISTS "events_role_write_del" ON "events";--> statement-breakpoint
DROP POLICY IF EXISTS "projects_role_write_ins" ON "projects";--> statement-breakpoint
DROP POLICY IF EXISTS "projects_role_write_upd" ON "projects";--> statement-breakpoint
DROP POLICY IF EXISTS "projects_role_write_del" ON "projects";--> statement-breakpoint
DROP POLICY IF EXISTS "workspaces_role_write_ins" ON "workspaces";--> statement-breakpoint
DROP POLICY IF EXISTS "workspaces_role_write_upd" ON "workspaces";--> statement-breakpoint
DROP POLICY IF EXISTS "workspaces_role_write_del" ON "workspaces";--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_keys_role_write_ins" ON "workspace_keys";--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_keys_role_write_upd" ON "workspace_keys";--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_keys_role_write_del" ON "workspace_keys";--> statement-breakpoint
DROP POLICY IF EXISTS "report_artifacts_role_write_ins" ON "report_artifacts";--> statement-breakpoint
DROP POLICY IF EXISTS "report_artifacts_role_write_upd" ON "report_artifacts";--> statement-breakpoint
DROP POLICY IF EXISTS "report_artifacts_role_write_del" ON "report_artifacts";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commits_role_write_ins" ON "git_commits";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commits_role_write_upd" ON "git_commits";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commits_role_write_del" ON "git_commits";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commit_files_role_write_ins" ON "git_commit_files";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commit_files_role_write_upd" ON "git_commit_files";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commit_files_role_write_del" ON "git_commit_files";--> statement-breakpoint
DROP POLICY IF EXISTS "session_git_links_role_write_ins" ON "session_git_links";--> statement-breakpoint
DROP POLICY IF EXISTS "session_git_links_role_write_upd" ON "session_git_links";--> statement-breakpoint
DROP POLICY IF EXISTS "session_git_links_role_write_del" ON "session_git_links";--> statement-breakpoint
DROP POLICY IF EXISTS "machine_heartbeats_role_write_ins" ON "machine_heartbeats";--> statement-breakpoint
DROP POLICY IF EXISTS "machine_heartbeats_role_write_upd" ON "machine_heartbeats";--> statement-breakpoint
DROP POLICY IF EXISTS "machine_heartbeats_role_write_del" ON "machine_heartbeats";--> statement-breakpoint
DROP POLICY IF EXISTS "alert_firings_role_write_ins" ON "alert_firings";--> statement-breakpoint
DROP POLICY IF EXISTS "alert_firings_role_write_upd" ON "alert_firings";--> statement-breakpoint
DROP POLICY IF EXISTS "alert_firings_role_write_del" ON "alert_firings";--> statement-breakpoint
DROP POLICY IF EXISTS "search_documents_role_write_ins" ON "search_documents";--> statement-breakpoint
DROP POLICY IF EXISTS "search_documents_role_write_upd" ON "search_documents";--> statement-breakpoint
DROP POLICY IF EXISTS "search_documents_role_write_del" ON "search_documents";--> statement-breakpoint
DROP POLICY IF EXISTS "project_grants_role_write_ins" ON "project_grants";--> statement-breakpoint
DROP POLICY IF EXISTS "project_grants_role_write_upd" ON "project_grants";--> statement-breakpoint
DROP POLICY IF EXISTS "project_grants_role_write_del" ON "project_grants";--> statement-breakpoint
DROP POLICY IF EXISTS "project_grants_org_isolation" ON "project_grants";--> statement-breakpoint
ALTER TABLE "project_grants" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "project_grants";
