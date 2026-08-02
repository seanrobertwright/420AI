-- M15 15.10 the APPEND-ONLY audit trail (D-15.10-2/3/4). The CREATE TABLE below is generated; the
-- policy block at the bottom is HAND-APPENDED, because `drizzle-kit generate` cannot emit
-- CREATE POLICY, REVOKE or ALTER TABLE ... ENABLE ROW LEVEL SECURITY — the same reason 0015 and
-- 0016 are hand-authored. Never re-run `db:generate` expecting the block below to survive.
--
-- WHY THE 13-TABLE STRICT PATTERN IS UNUSABLE HERE, and this is measured rather than assumed.
-- Every audit-worthy action originates from one of exactly two kinds of call site:
--
--   * `routes/members.ts` and `routes/org.ts` run inside `withOrg(..., principal.role, ...)`, so an
--     org context IS set and the role in context is the caller's (`admin`, `owner`, ...);
--   * `routes/api-keys.ts`, `routes/mfa.ts`, `routes/auth.ts` and `routes/sso.ts` are the IDENTITY
--     routes on `org-scoping.test.ts`'s ALLOWED_WITHOUT_WITHORG list. They run with NO org context
--     at all, by design — the row they read is part of what ESTABLISHES that context.
--
-- SPIKE check 8 drove the negative control against a live `420ai_test`: a strict org policy
-- (`org_id = nullif(current_setting('app.current_org', true), '')::uuid`) REJECTS an insert from the
-- unwrapped half outright — `new row violates row-level security policy`. Reusing the strict pattern
-- would therefore have turned every `api_key.minted` audit into a 500, and the failure would have
-- surfaced during UI work as "minting is broken", far from its cause. The 15.4 RESTRICTIVE role
-- policies are unusable for a sibling reason: a `viewer` is explicitly permitted to revoke their own
-- API key, and that must produce an audit row rather than a 500.
--
-- WHAT THE ONE POLICY BUYS, all four confirmed live (SPIKE checks 1, 1b, 2, 2b, 3, 4, 5, 5b, 5c):
--   * the app role APPENDS with or without an org context, at any role, always;
--   * the app role reads ZERO rows even WITH a matching org context set — it is the ABSENT SELECT
--     policy doing the work, not a failing predicate, so "write-only" is a database guarantee and
--     not a convention;
--   * the app role cannot rewrite or erase history;
--   * the OWNER reads everything — the D-M15-7 break-glass channel, intact.
--
-- `FORCE ROW LEVEL SECURITY` IS DELIBERATELY OMITTED, against all 13 strict tables. FORCE removes
-- the table-OWNER exemption, and the owner is exactly who performs the documented break-glass read.
-- It is a no-op today (the owner is also a superuser — a separate exemption) and actively harmful
-- the day the owner stops being one, a plausible hardening step. `rls.int.test.ts` asserts
-- `relforcerowsecurity = false` for this table ON PURPOSE, so nobody "completes the pattern" later.
--
-- NO `GRANT` STATEMENT IS NEEDED and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES ... TO "420ai_app"` covers tables created by the migration owner.
-- RE-VERIFIED live against 420ai_test during planning for THIS table shape — the app role received
-- INSERT implicitly. SELECT stays granted on purpose: a future audit VIEWER would then need only a
-- policy, not a grant. UPDATE and DELETE are revoked below.
--
-- CLASSIFICATION: `audit_events` joins a NEW `APPEND_ONLY_TABLES` list in `rls.int.test.ts` — not
-- `NO_RLS_TABLES` (it has a policy) and not either tenant list (nothing reads it per-tenant, so the
-- "all 17 tenant tables" count stays 17). Every count in that test is derived from list lengths.
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_email" text NOT NULL,
	"target_user_id" uuid,
	"target_email" text,
	"action" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_by_org_time" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint

-- ============================================================================
-- The WHOLE policy block. RLS ON, so default-deny applies to every command with no policy;
-- exactly ONE policy, and it is INSERT-only and unconditional.
-- ============================================================================
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Deliberately NOT `FORCE ROW LEVEL SECURITY` — see the header. The owner exemption IS the
-- break-glass read path.
CREATE POLICY "audit_events_append_only" ON "audit_events" FOR INSERT WITH CHECK (true);--> statement-breakpoint
-- Defence in depth, and diagnosability. The absent policy ALREADY blocks these: SPIKE checks 3/3b
-- measured a blocked UPDATE/DELETE as a SILENT 0-row no-op with the GRANT intact. The explicit
-- REVOKE turns the same attempt into a LOUD `permission denied` (SPIKE 5/5b), while INSERT keeps
-- working (5c). Both are safe; only one is diagnosable.
REVOKE UPDATE, DELETE ON "audit_events" FROM "420ai_app";
