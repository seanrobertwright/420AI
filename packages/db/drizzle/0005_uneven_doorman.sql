ALTER TABLE "events" ADD COLUMN "catalog_version" text;--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD COLUMN "catalog_version" text;--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD COLUMN "analysis_version" text;