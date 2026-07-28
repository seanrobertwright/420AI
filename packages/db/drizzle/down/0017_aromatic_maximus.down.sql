-- Down-migration for 0017_aromatic_maximus (M15 15.5). Reverses the identity core's SCHEMA:
-- drops `invites`'s four policies, then its RLS switches, then both new tables.
--
-- ORDERING DISCIPLINE, mirroring 0015/0016's downs: every POLICY is dropped before any table's
-- RLS is disabled or any table is dropped. Dropping a policy while RLS stays ENABLED is the state
-- that makes Postgres deny EVERYTHING (the 15.3 corollary in CLAUDE.md) — harmless here only
-- because the very next statements disable RLS on `invites` and then drop the table, so no window
-- exists in which a caller could observe the deny-all state through a live server.
--
-- `password_reset_tokens` carries no policy at all, so it is a bare DROP TABLE.
--
-- NOT REVERSED, deliberately: 0017's `UPDATE users SET email = lower(email)`. It is a
-- NORMALIZATION, not a data loss — the original mixed-case spelling is unrecoverable and,
-- more importantly, un-wanted: re-introducing case variance would re-open the second half of the
-- takeover chain D-M15-8 exists to close. A rollback therefore leaves emails lowercased, which is
-- byte-compatible with the pre-0017 code (a plain btree lookup on an already-lowercased value).
--
-- D-M15-13 rollback-drill note: this DOES discard data — outstanding invites and outstanding
-- reset tokens. Both are short-lived single-use credentials (7 days / 1 hour), so the cost of the
-- drill is that pending invitees must be re-invited. No `users` or `memberships` row is touched,
-- so nobody loses an account or an org.
DROP POLICY IF EXISTS "invites_role_write_ins" ON "invites";--> statement-breakpoint
DROP POLICY IF EXISTS "invites_role_write_upd" ON "invites";--> statement-breakpoint
DROP POLICY IF EXISTS "invites_role_write_del" ON "invites";--> statement-breakpoint
DROP POLICY IF EXISTS "invites_org_isolation" ON "invites";--> statement-breakpoint
ALTER TABLE "invites" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invites" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "invites";--> statement-breakpoint
DROP TABLE IF EXISTS "password_reset_tokens";
