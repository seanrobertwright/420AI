-- M16 16.3 the DECLARED half of capture health (research plan §7 P0.1; D-16.3-2/3/7). The CREATE
-- TABLE block below is GENERATED; the policy block at the bottom is HAND-APPENDED, because
-- `drizzle-kit generate` cannot emit CREATE POLICY or ALTER TABLE ... ENABLE ROW LEVEL SECURITY —
-- the same reason 0015, 0016, 0023 and 0024 are hand-edited. Never re-run `db:generate` expecting
-- the block below to survive; re-append it if you regenerate.
--
-- CLASSIFICATION: a STRICT TENANT TABLE, joining `STRICT_TABLES` in `rls.int.test.ts` and taking the
-- ordinary 0015 org policy plus the 0016 RESTRICTIVE role-write backstop. It is none of the other
-- four classifications, and it is worth saying why rather than only that:
--
--   * not BOOTSTRAP-PERMISSIVE — nothing reads this table in order to DISCOVER an org. The heartbeat
--     route has already resolved the org from `machines` (`getMachineOrgId`) before it writes here,
--     and every reader arrives from inside `withOrg` with a resolved principal.
--   * not APPEND_ONLY (0023's `audit_events` shape) — that classification's guarantee comes from an
--     ABSENT SELECT policy plus `REVOKE UPDATE, DELETE`, i.e. write-only. This table has a real
--     per-tenant READ path (it IS the scorecard) and `replaceMachineConnectors` must UPDATE on
--     conflict and DELETE to prune a connector the collector stopped reporting. APPEND_ONLY gives
--     neither.
--   * not NO_RLS — it carries `org_id` and holds tenant content.
--
-- `FORCE ROW LEVEL SECURITY` IS REQUIRED, as for every tenant table except `audit_events` (which
-- omits it because the owner IS its only break-glass reader). This table is read per-tenant through
-- the app role and has no owner-only read path to preserve. `rls.int.test.ts` asserts
-- `relforcerowsecurity = true` for every tenant table, so getting this backwards fails the gate.
--
-- NO `GRANT` STATEMENT IS NEEDED and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES ... TO "420ai_app"` (no FOR ROLE clause) covers tables created by the
-- migration owner, which is who runs every migration (0024 re-verified this live).
--
-- NO EXPLICIT `WITH CHECK` ON THE ORG POLICY, and that omission is load-bearing. A `FOR ALL` policy
-- with only `USING` applies that same expression as the INSERT/UPDATE `WITH CHECK`, so a cross-org
-- INSERT is already rejected LOUDLY (`new row violates row-level security policy`). Adding an
-- explicit clause would make this table's policy shape differ from the others and break the
-- inventory test's uniformity for no behavioural gain.
--
-- THE `nullif(..., '')` GUARD IS MANDATORY, copied verbatim from 0015: `current_setting(x, true)`
-- returns '' (not NULL) when unset, and `''::uuid` raises `invalid input syntax for type uuid`.
-- Without it an unset context turns every query into a 500 instead of an empty result — a backstop
-- must fail closed and QUIET.
--
-- THE UNIQUE INDEX LEADS WITH `machine_id`, NOT `connector_id`. `connector_id` is a
-- connector-supplied, globally-scoped string that two tenants can share (the 15.1/15.2 lesson);
-- `machine_id` is a uuid whose org is fixed by `machines.org_id` (D-M15-1). That ordering is also
-- what makes the declared × observed join in `repositories/capture-health.ts` structurally unable to
-- merge tenants — measured during planning as spike S5, where a connector-id-only join gave org A a
-- count of org B's events.
CREATE TABLE "machine_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"approval" text NOT NULL,
	"status" text NOT NULL,
	"capture_method" text NOT NULL,
	"liveness" text NOT NULL,
	"tokens" text NOT NULL,
	"cost" text NOT NULL,
	"known_gaps" text[] DEFAULT '{}'::text[] NOT NULL,
	"required_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom" boolean DEFAULT false NOT NULL,
	"last_error_message" text,
	"last_error_at" timestamp with time zone,
	"error_count" integer DEFAULT 0 NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_connectors" ADD CONSTRAINT "machine_connectors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_connectors" ADD CONSTRAINT "machine_connectors_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_connectors_machine_connector" ON "machine_connectors" USING btree ("machine_id","connector_id");--> statement-breakpoint
CREATE INDEX "machine_connectors_by_org" ON "machine_connectors" USING btree ("org_id");--> statement-breakpoint

-- ============================================================================
-- HAND-APPENDED. The 0015 STRICT org policy + the 0016 RESTRICTIVE role-write backstop.
-- 4 policies total: 1 PERMISSIVE/ALL + 3 RESTRICTIVE (INSERT/UPDATE/DELETE).
-- ============================================================================
ALTER TABLE "machine_connectors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_connectors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "machine_connectors_org_isolation" ON "machine_connectors" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint

-- The 15.4 role backstop. INSERT/UPDATE carry the test in WITH CHECK, which makes a blocked write
-- LOUD; DELETE must test in USING because Postgres has no WITH CHECK for DELETE, so a blocked delete
-- is an unavoidable, SILENT `DELETE 0` (the 15.4 lesson). Do not try to make it loud — the ROUTE
-- gate is the only layer that can be. The only writer here is the heartbeat route running as
-- SERVICE_ROLE, which passes `<> 'viewer'`; a `viewer` never writes this table at all.
CREATE POLICY "machine_connectors_role_write_ins" ON "machine_connectors" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "machine_connectors_role_write_upd" ON "machine_connectors" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "machine_connectors_role_write_del" ON "machine_connectors" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');