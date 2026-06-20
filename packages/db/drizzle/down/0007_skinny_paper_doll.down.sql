-- Down-migration for 0007_skinny_paper_doll (M12 12.4f). DROP TABLE cascades the version
-- unique index + the partial one-active index.
DROP TABLE "pricing_catalogs";
