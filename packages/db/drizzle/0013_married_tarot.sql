ALTER TABLE "search_documents" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "search_documents_by_session" ON "search_documents" USING btree ("session_id");