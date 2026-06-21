-- Down-migration for 0010_watery_spencer_smythe (M12 12.6). Reverses the 12.6 additive schema.
DROP TABLE "ingest_auth_failures";
--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "consecutive_sync_failures";
--> statement-breakpoint
ALTER TABLE "alert_firings" DROP COLUMN "delivery_attempted_at";
