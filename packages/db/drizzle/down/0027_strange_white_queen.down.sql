-- Down-migration for 0027 (M16 16.7, deployment-scoped alert firings).
--
-- D-M15-13 rollback-drill note: THERE IS DATA LOSS, and it is deliberate and bounded. Every open
-- DEPLOYMENT firing (`org_id IS NULL`) is resolved and then deleted, because there is no honest
-- place to put it in the pre-16.7 schema — `org_id` is NOT NULL there, and re-homing a deployment
-- row onto an arbitrary org would recreate defect 1 (one condition, N orgs) with the wrong org
-- picked by this script rather than by the product. `alert_firings` is a re-derivable projection of
-- a projection ("raw records sacred / events disposable" applies doubly), so the next reconcile
-- after a rollback re-opens the condition under the old per-user key within one tick. What is lost
-- is the `first_fired_at` of those specific rows, i.e. the age of at most two conditions.
--
-- THE ORDER IS THE REVERSE TRAP AND IT IS THE REASON THIS FILE IS NOT A SIMPLE MIRROR.
-- `ALTER COLUMN "org_id" SET NOT NULL` FAILS while any NULL row exists —
-- `column "org_id" of relation "alert_firings" contains null values` — and it fails at the END of
-- the script, after the indexes have already been swapped. Measured during planning, not assumed.
-- So the deployment rows must be disposed of FIRST, before anything else is touched.
--
-- The per-org duplicates that 0027 step 4 resolved are NOT resurrected: a resolved firing is a
-- correct terminal state, the old schema permits any number of them, and re-opening them would
-- reintroduce the duplicate deliveries this slice removed.

-- 1. Dispose of the deployment-scoped rows FIRST — nothing else can proceed while they exist.
--    Resolved-then-deleted rather than deleted outright so that a `pg_dump` taken between these two
--    statements (or an operator watching) sees the intent, and so the delete predicate is narrow.
UPDATE "alert_firings" SET "status" = 'resolved', "resolved_at" = now()
 WHERE "org_id" IS NULL AND "status" = 'open';--> statement-breakpoint
DELETE FROM "alert_firings" WHERE "org_id" IS NULL;--> statement-breakpoint

-- 2. Restore the pre-16.7 policy: STRICT org isolation, `USING` only (which Postgres copies to
--    WITH CHECK for a permissive ALL policy — 0015's exact spelling, restored byte-for-byte).
DROP POLICY IF EXISTS "alert_firings_org_isolation" ON "alert_firings";--> statement-breakpoint
CREATE POLICY "alert_firings_org_isolation" ON "alert_firings" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint

-- 3. Restore the pre-16.7 indexes. The old `(user_id, alert_key)` unique index can only build if no
--    org holds two open rows with the same key under DIFFERENT users — which is exactly what 0027
--    step 4 guaranteed and what the post-16.7 org index kept true, so this builds.
DROP INDEX IF EXISTS "alert_firings_open_key";--> statement-breakpoint
DROP INDEX IF EXISTS "alert_firings_open_global_key";--> statement-breakpoint
DROP INDEX IF EXISTS "alert_firings_by_org_status";--> statement-breakpoint
CREATE UNIQUE INDEX "alert_firings_open_key" ON "alert_firings" USING btree ("user_id","alert_key") WHERE "alert_firings"."status" = 'open';--> statement-breakpoint
CREATE INDEX "alert_firings_by_user_status" ON "alert_firings" USING btree ("user_id","status");--> statement-breakpoint

-- 4. …and only now can the column narrow again.
ALTER TABLE "alert_firings" ALTER COLUMN "org_id" SET NOT NULL;
