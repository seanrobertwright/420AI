CREATE TABLE "connector_catalogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_catalogs_version" ON "connector_catalogs" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_catalogs_one_active" ON "connector_catalogs" USING btree ("status") WHERE "connector_catalogs"."status" = 'active';