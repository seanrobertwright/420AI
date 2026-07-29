-- M15 15.6 sessions + revocation (D-M15-12; D-15.6-1…3). The generated DDL below is used AS IS:
-- unlike 0015/0016/0017 this migration appends NO policy block, and that absence is the decision
-- rather than an omission. `sessions` is an IDENTITY table (D-15.6-3) — keyed by `user_id` with no
-- `org_id` — read inside `resolvePrincipal` at the one moment before any org context exists.
-- It joins `users`, `organizations`, `memberships` and `password_reset_tokens` in
-- rls.int.test.ts's NO_RLS_TABLES, which asserts it carries NO policy at all.
--
-- No `GRANT` statement is needed and its absence is not a bug: 0015's
-- `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` covers tables created by the migration owner.
-- RE-VERIFIED live against the test DB during planning for THIS table shape — the app role was
-- granted DELETE, INSERT, SELECT, UPDATE implicitly and both inserted and selected with no
-- explicit grant.
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_by_user" ON "sessions" USING btree ("user_id");