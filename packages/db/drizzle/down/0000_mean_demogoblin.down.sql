-- Down-migration for 0000_mean_demogoblin (M12 12.4f). Reverses the initial schema:
-- drop tables in FK-safe order (children before parents); each DROP TABLE cascades its
-- own indexes + constraints, so no explicit DROP INDEX/CONSTRAINT is needed.
DROP TABLE "events";--> statement-breakpoint
DROP TABLE "ingest_tokens";--> statement-breakpoint
DROP TABLE "pairing_codes";--> statement-breakpoint
DROP TABLE "raw_source_records";--> statement-breakpoint
DROP TABLE "machines";--> statement-breakpoint
DROP TABLE "users";
