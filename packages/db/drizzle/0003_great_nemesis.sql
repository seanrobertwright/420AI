ALTER TABLE "machines" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "queue_pending" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "queue_inflight" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "collector_version" text;