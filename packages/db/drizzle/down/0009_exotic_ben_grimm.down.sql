-- Down-migration for 0009_exotic_ben_grimm (M12 12.4f). Reverses: ADD COLUMN password_hash.
ALTER TABLE "users" DROP COLUMN "password_hash";
