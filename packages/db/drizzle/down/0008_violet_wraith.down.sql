-- Down-migration for 0008_violet_wraith (M12 12.4f). DROP TABLE cascades the generated
-- tsvector column, the GIN index, the entity unique index, and the FK.
DROP TABLE "search_documents";
