-- Down-migration for 0003_great_nemesis (M12 12.4f). Reverses the 4 ADD COLUMN on machines.
ALTER TABLE "machines" DROP COLUMN "collector_version";--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "queue_inflight";--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "queue_pending";--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "last_heartbeat_at";
