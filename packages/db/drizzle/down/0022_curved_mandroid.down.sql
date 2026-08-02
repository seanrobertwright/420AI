-- Down-migration for 0022 (M15 15.9 follow-up). Drops the per-user live-name uniqueness.
--
-- SAFE AND LOSSLESS, unlike 0021's: no table, column or row is touched, and no key stops working.
-- The only consequence is that a user may again hold two live keys with the same name, which makes
-- the revoke list ambiguous but breaks nothing. The route's `duplicate_name` 409 simply stops
-- firing — it is driven by the index, so removing the index removes the error rather than
-- stranding a check with no enforcement behind it.
DROP INDEX IF EXISTS "api_keys_user_live_name";
