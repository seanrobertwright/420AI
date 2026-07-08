-- Down-migration for 0012_organic_hobgoblin (M13 13.5). Reverses the deliver-on-resolve
-- marker column added to alert_firings.
ALTER TABLE "alert_firings" DROP COLUMN "resolve_delivered_at";
