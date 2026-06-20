-- Down-migration for 0006_elite_lord_tyger (M12 12.4f). DROP TABLE cascades each table's
-- FKs + indexes (incl. the partial unique alert_firings_open_key + the heartbeat index).
DROP TABLE "alert_firings";--> statement-breakpoint
DROP TABLE "machine_heartbeats";
