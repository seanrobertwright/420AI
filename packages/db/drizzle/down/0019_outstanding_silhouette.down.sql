-- Down-migration for 0019 (M15 15.7). A bare DROP TABLE: `sso_identities` carries no policy and no
-- RLS switch, so there is no policy-ordering hazard of the kind 0015-0017's downs had to navigate.
--
-- D-M15-13 rollback-drill note: this DOES discard data — every provider link. The cost is that
-- each user must re-link after rolling forward again. It is NOT a lockout for a user who also has
-- a password, but it IS one for an SSO-created user (`password_hash` IS NULL), who must go through
-- password reset to regain access. No `users`, `memberships` or `sessions` row is touched, and
-- pre-0019 code ignores the table entirely.
DROP TABLE IF EXISTS "sso_identities";
