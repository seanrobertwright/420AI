-- Down-migration for 0015_shiny_iron_man (M15 15.3). Reverses the RLS backstop: drops all 15
-- policies, DISABLEs + NO FORCEs RLS on all 15 tables, then clears every privilege the role
-- holds in THIS database with a single `DROP OWNED BY` (which also removes the
-- ALTER DEFAULT PRIVILEGES entry that a mirror-image REVOKE leaves behind).
--
-- The role itself is deliberately LEFT IN PLACE, privilege-less — a role is cluster-wide while
-- a migration is per-database, so dropping it here is both impossible and undesirable. The full
-- argument, and how to drop it by hand, is at the `DROP OWNED BY` statement at the bottom.
--
-- WARNING: this removes the tenant-isolation BACKSTOP. Application-layer scoping (15.2's
-- explicit `orgId` predicates) survives and is unaffected — that is the PRIMARY defence — but
-- after this rollback a forgotten predicate is once again a silent cross-tenant read.
DROP POLICY IF EXISTS "raw_source_records_org_isolation" ON "raw_source_records";--> statement-breakpoint
DROP POLICY IF EXISTS "events_org_isolation" ON "events";--> statement-breakpoint
DROP POLICY IF EXISTS "projects_org_isolation" ON "projects";--> statement-breakpoint
DROP POLICY IF EXISTS "workspaces_org_isolation" ON "workspaces";--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_keys_org_isolation" ON "workspace_keys";--> statement-breakpoint
DROP POLICY IF EXISTS "report_artifacts_org_isolation" ON "report_artifacts";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commits_org_isolation" ON "git_commits";--> statement-breakpoint
DROP POLICY IF EXISTS "git_commit_files_org_isolation" ON "git_commit_files";--> statement-breakpoint
DROP POLICY IF EXISTS "session_git_links_org_isolation" ON "session_git_links";--> statement-breakpoint
DROP POLICY IF EXISTS "machine_heartbeats_org_isolation" ON "machine_heartbeats";--> statement-breakpoint
DROP POLICY IF EXISTS "alert_firings_org_isolation" ON "alert_firings";--> statement-breakpoint
DROP POLICY IF EXISTS "search_documents_org_isolation" ON "search_documents";--> statement-breakpoint
DROP POLICY IF EXISTS "machines_org_isolation" ON "machines";--> statement-breakpoint
DROP POLICY IF EXISTS "ingest_tokens_org_isolation" ON "ingest_tokens";--> statement-breakpoint
DROP POLICY IF EXISTS "pairing_codes_org_isolation" ON "pairing_codes";--> statement-breakpoint
ALTER TABLE "raw_source_records" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "raw_source_records" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_keys" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_keys" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_artifacts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_artifacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_commits" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_commits" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_commit_files" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_commit_files" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_git_links" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_git_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_firings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_firings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_documents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_documents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machines" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machines" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_tokens" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pairing_codes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pairing_codes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Revoke every privilege this migration granted, in THIS database.
--
-- `DROP OWNED BY` rather than three mirror-image REVOKEs, because hand-written REVOKEs are not
-- sufficient and the rollback drill proved it: `ALTER DEFAULT PRIVILEGES … REVOKE` left the
-- `pg_default_acl` entry behind. `DROP OWNED BY` removes every privilege granted to the role in
-- the current database AND its default-ACL entries — exactly the set 0015 created. The role owns
-- no objects, so nothing is destroyed.
--
-- The role itself is DELIBERATELY NOT DROPPED, and this too is a drill finding rather than a
-- preference. A Postgres role is CLUSTER-wide while a migration is PER-DATABASE: the same role
-- is granted in `420ai` and `420ai_test`, so `DROP ROLE` from either one fails with
-- `role "420ai_app" cannot be dropped because some objects depend on it` — the *other* database's
-- grants are the dependency. Worse, if it ever did succeed it would be a per-database rollback
-- silently breaking a different database's running server. A privilege-less leftover role is
-- inert; re-running `db:migrate` re-grants it, and `db:provision-app-role` is idempotent. Drop it
-- by hand (`DROP ROLE "420ai_app"`) only after rolling back EVERY database that uses it.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '420ai_app') THEN EXECUTE 'DROP OWNED BY "420ai_app"'; END IF; END $$;
