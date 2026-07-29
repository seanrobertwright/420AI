-- Down-migration for 0018 (M15 15.6). A bare DROP TABLE: `sessions` carries no policy and no RLS
-- switch, so there is no policy-ordering hazard of the kind 0015-0017's downs had to navigate.
--
-- D-M15-13 rollback-drill note: this DOES discard data — every live session. The cost of the
-- drill is that every logged-in user must log in again; the pre-0018 code accepts any unexpired
-- HMAC, so it is byte-compatible with tokens minted before AND after 0018 (the extra `sid` claim
-- is simply ignored by the older verifier). No `users` or `memberships` row is touched.
DROP TABLE IF EXISTS "sessions";
