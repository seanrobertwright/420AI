CREATE TABLE "git_commit_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"status" text NOT NULL,
	"insertions" integer NOT NULL,
	"deletions" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"repo_root_path" text NOT NULL,
	"git_branch" text,
	"author_name" text,
	"author_email" text,
	"authored_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"parents" text,
	"is_revert" boolean DEFAULT false NOT NULL,
	"files_changed" integer NOT NULL,
	"insertions" integer NOT NULL,
	"deletions" integer NOT NULL,
	"message_ciphertext" text,
	"message_iv" text,
	"message_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_git_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"project_id" uuid,
	"confidence" text NOT NULL,
	"status" text NOT NULL,
	"minutes_delta" integer,
	"file_overlap" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_commit_files" ADD CONSTRAINT "git_commit_files_commit_id_git_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."git_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commits" ADD CONSTRAINT "git_commits_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_git_links" ADD CONSTRAINT "session_git_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_git_links" ADD CONSTRAINT "session_git_links_commit_id_git_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."git_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_git_links" ADD CONSTRAINT "session_git_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_commit_files_by_commit" ON "git_commit_files" USING btree ("commit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_commits_machine_sha" ON "git_commits" USING btree ("machine_id","commit_sha");--> statement-breakpoint
CREATE INDEX "git_commits_by_root" ON "git_commits" USING btree ("repo_root_path");--> statement-breakpoint
CREATE UNIQUE INDEX "session_git_links_unique" ON "session_git_links" USING btree ("user_id","session_id","commit_id");--> statement-breakpoint
CREATE INDEX "session_git_links_by_commit" ON "session_git_links" USING btree ("commit_id");