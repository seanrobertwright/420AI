-- M15 15.7 SSO identities (D-M15-5; D-15.7-1…5). The generated DDL below is used AS IS: like 0018
-- and unlike 0015/0016/0017 this migration appends NO policy block, and that absence is the
-- decision rather than an omission. `sso_identities` is an IDENTITY table (D-15.7-3) — keyed by
-- `user_id` with no `org_id` — read at the one moment before any org context exists, because
-- resolving this row is part of what establishes it. It joins `users`, `organizations`,
-- `memberships`, `password_reset_tokens` and `sessions` in rls.int.test.ts's NO_RLS_TABLES, which
-- asserts it carries NO policy at all.
--
-- No `GRANT` statement is needed and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` covers tables created by the migration owner.
-- RE-VERIFIED live against 420ai_test during planning for THIS table shape (SPIKE 1) — the app
-- role was granted DELETE, INSERT, SELECT, UPDATE implicitly, and inserted a row with no explicit
-- grant. The table was also confirmed to come up with relrowsecurity = false and zero policies.
CREATE TABLE "sso_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_identities_provider_subject" ON "sso_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "sso_identities_by_user" ON "sso_identities" USING btree ("user_id");