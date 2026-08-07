-- M16 16.7 — re-home alert firings onto the ORG, and give the two deployment-global codes a
-- scope of their own (`org_id IS NULL`). Drizzle generated the four DDL statements; the three
-- data statements between them, and the policy amendment at the end, are hand-written, and the
-- ORDER of all eight is load-bearing.
--
-- WHAT WAS WRONG. `alert_firings` has been keyed on `(user_id, alert_key)` since M10 3c, when the
-- product was single-user and `user_id` was a faithful proxy for "whose archive is this". M15 made
-- the tenancy boundary the ORGANIZATION and M16 16.6 added a background evaluator tick that loops
-- every org. Between them those turned a dormant modelling error into two live defects:
--
--   1. `catalog.update_requires_approval` and `ingest.auth_failure` derive from tables with NO
--      `org_id` at all (`pricing_catalogs`, `ingest_auth_failures`). One pending catalog therefore
--      opened a firing in EVERY org, and with a deliverer wired sent one notice per org plus one
--      resolve notice per org. `ensurePersonalOrg` gives every user their own org, so org count
--      tracks USER count — inviting two teammates makes that a three- or four-org deployment.
--   2. Within ONE org, an `admin` or `viewer` opening the monitor opened a SECOND row under their
--      own user id and triggered a second delivery, because `user_id` was in the key.
--
-- WHY TWO UNIQUE INDEXES AND NOT ONE — the fact the next reader will most want to second-guess.
-- Under a unique index `NULL <> NULL`, so `("org_id","alert_key")` places NO CONSTRAINT AT ALL on
-- rows whose `org_id` is NULL. Measured against real Postgres during planning, not assumed: a
-- second NULL-org row for the same `alert_key` inserted cleanly. A single composite index would
-- therefore have "fixed" defect 1 by permitting UNLIMITED deployment duplicates. So there are two
-- partial indexes and the org one carries an explicit `AND "org_id" IS NOT NULL`, which makes them
-- PARTITION the table rather than overlap it.
--
-- A related measured result the repository depends on: using the ORG arbiter in an
-- `ON CONFLICT … WHERE` against a global row does NOT silently insert a duplicate — Postgres
-- suppresses conflicts only on the INFERRED arbiter index, so a conflict on the other unique index
-- is a plain `duplicate key value violates unique constraint "alert_firings_open_global_key"`.
-- The org/deployment upsert split is enforced by the database, loudly. Do not merge the two
-- statements in `repositories/alert-firings.ts` into one "clever" one.
--
-- STATEMENT ORDER IS LOAD-BEARING. The dedupe MUST precede index creation — both indexes fail to
-- build against the pre-state, which by construction holds exactly the duplicates they forbid.
-- Widening the column must precede the dedupe, because step 2 writes a NULL.
--
-- `split_part("alert_key", ':', 1)` recovers the alert CODE because `alertKey` is
-- `${code}:${machineId ?? connector ?? "*"}` (`packages/shared/src/alert-firings.ts`) and no member
-- of the `AlertCode` union contains a colon — pinned by a unit test in
-- `packages/shared/src/alert-firings.test.ts` so that a future code breaking the assumption fails
-- loudly rather than corrupting a later dedupe.
--
-- LOCKING: `ALTER COLUMN … DROP NOT NULL` takes ACCESS EXCLUSIVE but is a catalog-only change
-- (dropping a constraint needs no table scan). The three UPDATEs touch only `status = 'open'` rows,
-- of which a healthy deployment holds single digits. The index builds take SHARE. All are
-- sub-second at any plausible `alert_firings` size; CONCURRENTLY is deliberately NOT used because
-- it cannot run inside the runner's transaction (same reasoning as 0026).

-- 1. Widen the column BEFORE anything can write a NULL, and drop the old constraints so the
--    dedupe below is not fighting them.
ALTER TABLE "alert_firings" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "alert_firings_open_key";--> statement-breakpoint
DROP INDEX "alert_firings_by_user_status";--> statement-breakpoint

-- 2. Promote the OLDEST open row per GLOBAL key to the deployment scope, keeping its
--    `first_fired_at` — the field the firing record exists for. `DISTINCT ON` with
--    `ORDER BY ("alert_key", "first_fired_at" ASC, "id" ASC)`; `id` breaks ties deterministically
--    so re-running this on a copy picks the same winner.
UPDATE "alert_firings" SET "org_id" = NULL
 WHERE "id" IN (
   SELECT DISTINCT ON ("alert_key") "id" FROM "alert_firings"
    WHERE "status" = 'open'
      AND split_part("alert_key", ':', 1) IN ('catalog.update_requires_approval','ingest.auth_failure')
    ORDER BY "alert_key", "first_fired_at" ASC, "id" ASC);--> statement-breakpoint

-- STEPS 3 AND 4 STAMP `resolve_delivered_at`, AND THAT IS NOT BOOKKEEPING TIDINESS — IT IS THE
-- DIFFERENCE BETWEEN A SILENT MIGRATION AND A BURST OF FALSE ALL-CLEARS.
--
-- `deliverResolvedFirings` claims exactly the shape these two UPDATEs would otherwise leave behind:
--   status='resolved' AND resolved_at IS NOT NULL AND delivery_attempted_at IS NOT NULL
--   AND resolve_delivered_at IS NULL
-- and — unlike every list read — it carries NO age or window filter whatsoever. So the first
-- `GET /v1/monitor`, SSE frame or evaluator tick after this migration would send one
-- `alert.resolved` notice for EVERY row deduped below that had already been delivered.
--
-- The notices would be lies. A row resolved by step 3 is a duplicate of a condition whose surviving
-- row (promoted to the deployment scope by step 2) is STILL OPEN — so the operator gets
-- "catalog.update_requires_approval RESOLVED" for a catalog that is still pending, alongside the
-- open firing for the same condition. Step 4 has the identical shape one scope down.
--
-- These resolutions are the migration's OWN bookkeeping, not an observation that anything cleared,
-- so they are marked already-notified. That is the honest reading of `resolve_delivered_at`: "no
-- resolve notice is owed for this row."
--
-- 3. Resolve the per-org duplicates of those global conditions. They are re-derivable projections
--    ("events disposable", doubly so for a projection of a projection) and the surviving row from
--    step 2 carries the original `first_fired_at`, so no history is lost.
UPDATE "alert_firings" SET "status" = 'resolved', "resolved_at" = now(), "resolve_delivered_at" = now()
 WHERE "status" = 'open' AND "org_id" IS NOT NULL
   AND split_part("alert_key", ':', 1) IN ('catalog.update_requires_approval','ingest.auth_failure');--> statement-breakpoint

-- 4. Collapse per-USER duplicates WITHIN an org (defect 2): keep the oldest, resolve the rest.
UPDATE "alert_firings" SET "status" = 'resolved', "resolved_at" = now(), "resolve_delivered_at" = now()
 WHERE "status" = 'open' AND "org_id" IS NOT NULL AND "id" NOT IN (
   SELECT DISTINCT ON ("org_id", "alert_key") "id" FROM "alert_firings"
    WHERE "status" = 'open' AND "org_id" IS NOT NULL
    ORDER BY "org_id", "alert_key", "first_fired_at" ASC, "id" ASC);--> statement-breakpoint

-- 5. Only NOW can the constraints exist.
CREATE UNIQUE INDEX "alert_firings_open_key" ON "alert_firings" USING btree ("org_id","alert_key") WHERE "alert_firings"."status" = 'open' AND "alert_firings"."org_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_firings_open_global_key" ON "alert_firings" USING btree ("alert_key") WHERE "alert_firings"."status" = 'open' AND "alert_firings"."org_id" IS NULL;--> statement-breakpoint
CREATE INDEX "alert_firings_by_org_status" ON "alert_firings" USING btree ("org_id","status");--> statement-breakpoint

-- 6. The policy amendment (hand-written — `schema.ts` declares no policies; mirrors 0015/0016).
--
--    `OR org_id IS NULL` is the whole point and it is NOT cosmetic: measured as a negative control
--    during planning, under the UNAMENDED strict policy the promoted deployment row is INVISIBLE to
--    every org, so the dashboard would show neither global code at all.
--
--    Note carefully what this `IS NULL` tests: the ROW'S COLUMN ("this row belongs to the
--    deployment ⇒ everyone sees it"). That is the OPPOSITE property to the BOOTSTRAP tables'
--    `NULLIF(current_setting(…), '') IS NULL` ("no context ⇒ see everything"), which tests the
--    SETTING. `rls.int.test.ts` classifies this table in its own list for exactly that reason — a
--    substring match on "IS NULL" cannot tell the two apart.
--
--    `WITH CHECK` is spelled out explicitly even though a permissive ALL policy with only `USING`
--    copies it. Both halves were measured: an unset-org transaction may INSERT a deployment row
--    (WITH CHECK passes on `org_id IS NULL`) and is still REFUSED an org-scoped insert
--    (`new row violates row-level security policy`). No tenancy hole is opened.
DROP POLICY "alert_firings_org_isolation" ON "alert_firings";--> statement-breakpoint
CREATE POLICY "alert_firings_org_isolation" ON "alert_firings"
  USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid OR org_id IS NULL)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid OR org_id IS NULL);
