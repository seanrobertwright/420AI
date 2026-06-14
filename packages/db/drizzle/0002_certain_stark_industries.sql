CREATE TABLE "report_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"report_type" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"version" integer NOT NULL,
	"report_version" text NOT NULL,
	"params" jsonb,
	"metrics" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_artifacts_scope_version" ON "report_artifacts" USING btree ("user_id","report_type","scope_id","version");--> statement-breakpoint
CREATE INDEX "report_artifacts_by_scope" ON "report_artifacts" USING btree ("user_id","report_type","scope_id");