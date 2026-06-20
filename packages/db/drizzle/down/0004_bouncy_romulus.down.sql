-- Down-migration for 0004_bouncy_romulus (M12 12.4f). Drop the 3 new tables in FK-safe order:
-- session_git_links AND git_commit_files both reference git_commits, so both children drop
-- before the parent. DROP TABLE cascades each table's own indexes + constraints.
DROP TABLE "session_git_links";--> statement-breakpoint
DROP TABLE "git_commit_files";--> statement-breakpoint
DROP TABLE "git_commits";
