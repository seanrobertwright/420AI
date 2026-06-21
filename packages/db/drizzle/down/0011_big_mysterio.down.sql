-- Down-migration for 0011_big_mysterio (M12 12.7c). DROP TABLE cascades the version
-- unique index + the partial one-active index.
DROP TABLE IF EXISTS "connector_catalogs";
