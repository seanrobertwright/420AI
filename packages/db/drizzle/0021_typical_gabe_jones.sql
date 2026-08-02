-- M15 15.9 API keys (D-M15-7; D-15.9-1/2/3/8). The generated DDL below is used AS IS: like 0018,
-- 0019 and 0020, and unlike 0015/0016/0017, this migration appends NO policy block, and that
-- absence is the decision rather than an omission. `api_keys` is an IDENTITY table (D-15.9-1) —
-- keyed by `user_id` with no `org_id` — read INSIDE `resolvePrincipal`, at the one moment before
-- any org context exists, because resolving this row is part of what establishes that context. A
-- strict policy here would read zero rows and every API key would silently 401. It joins `users`,
-- `organizations`, `memberships`, `password_reset_tokens`, `sessions`, `sso_identities`,
-- `totp_credentials` and `mfa_recovery_codes` in rls.int.test.ts's NO_RLS_TABLES, which asserts it
-- carries NO policy at all. Every count in that test is DERIVED from the list lengths, so adding an
-- entry moves no expected number and the "all 17 tenant tables" title stays 17.
--
-- No `GRANT` statement is needed and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES ... TO "420ai_app"` covers tables created by the migration owner.
-- RE-VERIFIED live against 420ai_test during planning for THIS table shape (SPIKE 1) — the app role
-- received DELETE, INSERT, SELECT, UPDATE implicitly, hash-looked-up a row with NO org context set
-- (SPIKE 2), and the table came up with relrowsecurity = false, relforcerowsecurity = false and zero
-- policies. If that ever stops being true the table needs a GRANT block, not a policy.
--
-- `token_hash` is SHA-256 via `hashToken` and UNIQUE, so the pre-context auth read is one indexed
-- probe (the `ingest_tokens` / `password_reset_tokens` shape). `role` is NULLABLE = "inherit the
-- owner's membership role"; `expires_at` is NULLABLE = "never expires", which is why every live-key
-- predicate must be `expires_at IS NULL OR expires_at > $now` — a bare `>` silently invalidates
-- every never-expiring key. `last_used_at` exists here and deliberately not on `sessions`; the write
-- is throttled in process and fire-and-forget (D-15.9-7).
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_by_user" ON "api_keys" USING btree ("user_id");