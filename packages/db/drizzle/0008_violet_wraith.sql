CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"project_id" uuid,
	"title" text,
	"body" text NOT NULL,
	"redaction_version" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')) STORED
);
--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_entity" ON "search_documents" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "search_documents_gin" ON "search_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "search_documents_by_project" ON "search_documents" USING btree ("project_id");