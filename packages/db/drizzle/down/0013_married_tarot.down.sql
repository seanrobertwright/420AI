-- Down-migration for 0013_married_tarot (M14 14.4). Drop the grouping index
-- then the nullable session_id column; existing rows are otherwise untouched.
DROP INDEX "search_documents_by_session";
ALTER TABLE "search_documents" DROP COLUMN "session_id";
