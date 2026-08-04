-- M16 16.1 the §4.3 OUTCOME LABEL model (research plan §4.3 / §7 P0.2; D-16.1-1/2/3/6/8). The two
-- CREATE TABLE blocks below are GENERATED; the policy block at the bottom is HAND-APPENDED, because
-- `drizzle-kit generate` cannot emit CREATE POLICY or ALTER TABLE ... ENABLE ROW LEVEL SECURITY —
-- the same reason 0015, 0016 and 0023 are hand-edited. Never re-run `db:generate` expecting the
-- block below to survive; re-append it if you regenerate.
--
-- CLASSIFICATION: BOTH tables are STRICT TENANT TABLES, joining `STRICT_TABLES` in
-- `rls.int.test.ts` (13 -> 15) and taking the ordinary 0015 org policy plus the 0016 RESTRICTIVE
-- role-write backstop. Neither is any of the other four classifications, and it is worth saying why
-- rather than only that:
--
--   * not BOOTSTRAP-PERMISSIVE — no path reads a label in order to DISCOVER an org. Every caller
--     already holds a resolved principal and reaches these tables from inside `withOrg`.
--   * not APPEND_ONLY (0023's `audit_events` shape) — that classification's guarantee comes from an
--     ABSENT SELECT policy plus `REVOKE UPDATE, DELETE`, i.e. write-only. Both tables here have a
--     real per-tenant READ path (the label surface renders its own history to its author), and both
--     must be DELETABLE by the app role (D-16.1-6). APPEND_ONLY gives neither.
--   * not NO_RLS — they carry `org_id` and hold tenant content.
--
-- WHY `outcome_label_revisions` IS STRICT RATHER THAN APPEND_ONLY, restated because the instinct
-- runs the other way: it IS an immutable history, and that immutability is enforced in the
-- REPOSITORY (nothing ever issues an UPDATE against it) rather than by the database. That is a
-- deliberate trade, and the deciding constraint is the DELETE — D-16.1-6 hard-deletes a label and
-- all of its revisions in one transaction, which an APPEND_ONLY table's `REVOKE DELETE` would make
-- impossible.
--
-- `FORCE ROW LEVEL SECURITY` IS REQUIRED HERE, unlike `audit_events` which deliberately omits it.
-- FORCE removes the table-OWNER exemption; `audit_events` omits it because the owner IS its only
-- (break-glass) reader, whereas these tables are read per-tenant through the app role and have no
-- owner-only read path to preserve. `rls.int.test.ts` test 9 asserts `relforcerowsecurity = true`
-- for every tenant table, so getting this backwards fails the gate.
--
-- NO `GRANT` STATEMENT IS NEEDED and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES ... TO "420ai_app"` (no FOR ROLE clause) covers tables created by the
-- migration owner, which is who runs every migration. RE-VERIFIED live against `420ai_test` during
-- planning for this exact table shape — the app role received SELECT/INSERT/UPDATE/DELETE with no
-- explicit grant.
--
-- NO EXPLICIT `WITH CHECK` ON THE ORG POLICY, and that omission is load-bearing. A `FOR ALL` policy
-- with only `USING` applies that same expression as the INSERT/UPDATE `WITH CHECK`, so a cross-org
-- INSERT is already rejected LOUDLY (`new row violates row-level security policy` — measured during
-- planning). Adding an explicit clause would make these two tables' policy shape differ from the
-- other thirteen and break the inventory test's uniformity for no behavioural gain.
--
-- THE `nullif(..., '')` GUARD IS MANDATORY, copied verbatim from 0015: `current_setting(x, true)`
-- returns '' (not NULL) when unset, and `''::uuid` raises `invalid input syntax for type uuid`.
-- Without it an unset context turns every query into a 500 instead of an empty result — a backstop
-- must fail closed and QUIET.
CREATE TABLE "outcome_label_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"author_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"task_type" text,
	"intent" text,
	"outcome" text,
	"quality_rating" integer,
	"primary_friction" text,
	"follow_up_commit_or_pr" text,
	"confidence" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"task_type" text,
	"intent" text,
	"outcome" text,
	"quality_rating" integer,
	"primary_friction" text,
	"follow_up_commit_or_pr" text,
	"confidence" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outcome_label_revisions" ADD CONSTRAINT "outcome_label_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_label_revisions" ADD CONSTRAINT "outcome_label_revisions_label_id_outcome_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."outcome_labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_label_revisions" ADD CONSTRAINT "outcome_label_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_labels" ADD CONSTRAINT "outcome_labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_labels" ADD CONSTRAINT "outcome_labels_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_label_revisions_label_revision" ON "outcome_label_revisions" USING btree ("label_id","revision");--> statement-breakpoint
CREATE INDEX "outcome_label_revisions_by_org" ON "outcome_label_revisions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_labels_org_session" ON "outcome_labels" USING btree ("org_id","session_id");--> statement-breakpoint
CREATE INDEX "outcome_labels_by_org_updated" ON "outcome_labels" USING btree ("org_id","updated_at");--> statement-breakpoint

-- ============================================================================
-- HAND-APPENDED. The 0015 STRICT org policy + the 0016 RESTRICTIVE role-write backstop, per table.
-- 8 policies total: 2 PERMISSIVE/ALL + 6 RESTRICTIVE (INSERT/UPDATE/DELETE each).
-- ============================================================================
ALTER TABLE "outcome_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outcome_labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "outcome_labels_org_isolation" ON "outcome_labels" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "outcome_label_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outcome_label_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "outcome_label_revisions_org_isolation" ON "outcome_label_revisions" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint

-- The 15.4 role backstop. INSERT/UPDATE carry the test in WITH CHECK, which makes a blocked write
-- LOUD; DELETE must test in USING because Postgres has no WITH CHECK for DELETE, so a blocked
-- delete is an unavoidable, SILENT `DELETE 0` (the 15.4 lesson). Do not try to make it loud — the
-- ROUTE gate is the only layer that can be — and `outcome-labels.int.test.ts` asserts that silence
-- explicitly, so nobody later "fixes" it into an expectation the database cannot meet.
CREATE POLICY "outcome_labels_role_write_ins" ON "outcome_labels" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "outcome_labels_role_write_upd" ON "outcome_labels" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "outcome_labels_role_write_del" ON "outcome_labels" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "outcome_label_revisions_role_write_ins" ON "outcome_label_revisions" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "outcome_label_revisions_role_write_upd" ON "outcome_label_revisions" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "outcome_label_revisions_role_write_del" ON "outcome_label_revisions" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');