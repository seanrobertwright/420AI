-- Down-migration for 0020 (M15 15.8). Two bare DROP TABLEs: neither table carries a policy or an RLS
-- switch, so there is no policy-ordering hazard of the kind 0015-0017's downs had to navigate. The
-- order below is FK-free either way (both reference `users`, and neither references the other), so
-- it is safe rather than significant.
--
-- D-M15-13 rollback-drill note: this DOES discard data, and the consequence is stated plainly
-- because it is easy to under-read. Rolling back DISABLES MFA FOR EVERY ENROLLED USER and DISCARDS
-- EVERY RECOVERY CODE. That is not a lockout — a user's password or SSO link is untouched, and
-- `mintSessionOrChallenge` simply finds no credential and mints a session as it did before 15.8 —
-- but it SILENTLY DOWNGRADES every enrolled account to a single factor, with no signal to the user
-- that their second factor stopped being asked for. Rolling forward again does NOT restore the
-- secrets: each user must re-enrol from scratch and save a new set of recovery codes.
--
-- `db:rollback` applies only the LATEST migration, so this file is the whole rollback surface. No
-- `users`, `memberships`, `sessions` or `sso_identities` row is touched, and pre-0020 code ignores
-- both tables entirely.
DROP TABLE IF EXISTS "mfa_recovery_codes";
--> statement-breakpoint
DROP TABLE IF EXISTS "totp_credentials";
