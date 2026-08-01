-- M15 15.8 MFA (D-M15-5; D-15.8-6/7/13). The generated DDL below is used AS IS: like 0018 and 0019,
-- and unlike 0015/0016/0017, this migration appends NO policy block, and that absence is the decision
-- rather than an omission. Both tables are IDENTITY tables (D-15.8-13) — keyed by `user_id` with no
-- `org_id` — read at the one moment before any org context exists: a second factor is presented
-- BEFORE a session is minted, so there is nothing to scope by yet. They join `users`,
-- `organizations`, `memberships`, `password_reset_tokens`, `sessions` and `sso_identities` in
-- rls.int.test.ts's NO_RLS_TABLES, which asserts they carry NO policy at all. Every count in that
-- test is DERIVED from the list lengths, so adding two entries moves no expected number.
--
-- No `GRANT` statement is needed and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES ... TO "420ai_app"` covers tables created by the migration owner.
-- RE-VERIFIED live against 420ai_test during planning for THESE table shapes (SPIKE 3) — the app
-- role was granted DELETE, INSERT, SELECT, UPDATE implicitly on both, inserted and read with no
-- explicit grant, and both came up with relrowsecurity = false, relforcerowsecurity = false and
-- zero policies.
--
-- `totp_credentials.secret_*` is the FOURTH encrypted column trio in the schema (AES-256-GCM via
-- `encryptField`), and `reencryptAll` is extended in the same slice to cover it — see D-15.8-6.
-- `last_step` is deliberately `integer` and not `bigint`: node-postgres returns `int8` as a JS
-- STRING, which would silently make the replay comparison a string comparison.
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "totp_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_step" integer,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_credentials" ADD CONSTRAINT "totp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_recovery_codes_user_hash" ON "mfa_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_by_user" ON "mfa_recovery_codes" USING btree ("user_id");