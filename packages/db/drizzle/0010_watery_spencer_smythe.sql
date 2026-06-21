CREATE TABLE "ingest_auth_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"remote_ip" text
);
--> statement-breakpoint
ALTER TABLE "alert_firings" ADD COLUMN "delivery_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "consecutive_sync_failures" integer;--> statement-breakpoint
CREATE INDEX "ingest_auth_failures_by_ts" ON "ingest_auth_failures" USING btree ("ts");