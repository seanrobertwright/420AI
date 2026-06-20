-- Down-migration for 0001_naive_dreaming_celestial (M12 12.4f). Drops the index added to the
-- pre-existing events table FIRST (it survives the new-table drops), then the 3 new tables in
-- FK-safe order (workspace_keys → workspaces → projects).
DROP INDEX "events_by_project_path";--> statement-breakpoint
DROP TABLE "workspace_keys";--> statement-breakpoint
DROP TABLE "workspaces";--> statement-breakpoint
DROP TABLE "projects";
