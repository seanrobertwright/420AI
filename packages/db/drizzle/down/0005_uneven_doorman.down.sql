-- Down-migration for 0005_uneven_doorman (M12 12.4f). Reverses the 3 ADD COLUMN
-- (events.catalog_version + report_artifacts.catalog_version/analysis_version).
ALTER TABLE "report_artifacts" DROP COLUMN "analysis_version";--> statement-breakpoint
ALTER TABLE "report_artifacts" DROP COLUMN "catalog_version";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "catalog_version";
