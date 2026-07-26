-- Down-migration for 0014_loose_pyro (M15 15.1). Reverses the org-scoped search index,
-- the 15 org_id columns, and both new tables. Each DROP COLUMN cascades away that
-- column's FK constraint AND its *_by_org index automatically, so neither needs an
-- explicit statement here.
--
-- WARNING: this DESTROYS tenancy data. Restoring the globally-unique
-- `search_documents_entity` index FAILS LOUDLY if two orgs hold the same
-- (entity_type, entity_id) — which is CORRECT: rolling back a genuinely multi-tenant
-- archive must not silently discard rows.
DROP INDEX "search_documents_entity";--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "pairing_codes" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "ingest_tokens" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "raw_source_records" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "workspace_keys" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "report_artifacts" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "git_commits" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "git_commit_files" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "session_git_links" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "machine_heartbeats" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "alert_firings" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "search_documents" DROP COLUMN "org_id";--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_entity" ON "search_documents" USING btree ("entity_type","entity_id");--> statement-breakpoint
DROP TABLE "memberships";--> statement-breakpoint
DROP TABLE "organizations";
