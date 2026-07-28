-- M15 15.5 identity core (D-M15-5/D-M15-6/D-M15-8; D-15.5-1…3). HAND-EDITED on top of the
-- drizzle-generated DDL for the two new tables — `drizzle-kit generate` cannot emit CREATE POLICY,
-- so the whole policy block below is hand-authored. Mirrors 0014/0015/0016's convention.
--
-- Three things ship here:
--   (1) `invites` — an ORG-OWNED, privilege-granting credential row. Bootstrap-permissive on the
--       ORG axis, restrictive on the ROLE axis. The first table in the repo with that combination
--       (D-15.5-2), which is why it earns its own classification constant in rls.int.test.ts.
--   (2) `password_reset_tokens` — an IDENTITY-owned credential row. NO org_id, and therefore NO
--       RLS at all, for the same reason `users`/`organizations`/`memberships` carry none
--       (D-15.3-4 / D-15.5-1): it is read at the one moment before any identity exists.
--   (3) The email NORMALIZATION of existing `users` rows (D-15.5-3).
--
-- No `GRANT` statement is needed and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` (no FOR ROLE clause) covers tables created by the
-- migration owner, which was VERIFIED live against the test DB during planning — the app role
-- INSERTed and SELECTed on a table created seconds earlier with no explicit grant.
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_by_org" ON "invites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invites_by_email" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_by_user" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint

-- (everything below is appended by hand — see the header.)

-- D-15.5-3: emails become case-insensitive by NORMALIZATION. `users_email_unique` is a plain
-- btree on `email` (verified against the live test DB), so `Foo@x.com` and `foo@x.com` are two
-- accounts today. This UPDATE will FAIL LOUDLY on that unique index if such a pair exists — which
-- is the correct outcome: a human must decide which account survives. Do NOT add ON CONFLICT.
UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint

-- `invites` — BOOTSTRAP-PERMISSIVE org policy, copied verbatim from 0015's `pairing_codes`
-- (line 89). Accepting an invite reads the row IN ORDER TO discover the org, exactly as
-- `redeemPairingCode` does, so a strict policy would read zero rows under the app role.
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "invites_org_isolation" ON "invites" USING (nullif(current_setting('app.current_org', true), '') IS NULL OR org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint

-- …AND the 15.4 role-write backstop, which the other three bootstrap tables deliberately lack
-- (D-15.5-2). They are written by machine paths with no membership role; an invite is written by
-- a principal and GRANTS PRIVILEGE. Shape copied verbatim from 0016 lines 70-72: INSERT/UPDATE
-- test in WITH CHECK (LOUD), DELETE in USING (unavoidably silent — Postgres has no WITH CHECK
-- for DELETE, and the route gate is the only loud layer there).
CREATE POLICY "invites_role_write_ins" ON "invites" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "invites_role_write_upd" ON "invites" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "invites_role_write_del" ON "invites" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');

-- `password_reset_tokens` gets NO policy at all (D-15.3-4 / D-15.5-1): it is an identity table,
-- read at the one moment before any identity — and therefore any org context — exists.
