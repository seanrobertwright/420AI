CREATE TABLE "events" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"source_connector" text NOT NULL,
	"parser_version" text NOT NULL,
	"raw_record_id" text NOT NULL,
	"event_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"session_id" text NOT NULL,
	"machine_id" uuid,
	"project_path" text,
	"git_branch" text,
	"model" text,
	"ts" timestamp with time zone NOT NULL,
	"tokens" jsonb,
	"cost" jsonb,
	"payload_ciphertext" text,
	"payload_iv" text,
	"payload_tag" text
);
--> statement-breakpoint
CREATE TABLE "ingest_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ingest_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"os" text,
	"hostname" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"source_connector" text NOT NULL,
	"session_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"payload_iv" text NOT NULL,
	"payload_tag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD CONSTRAINT "ingest_tokens_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD CONSTRAINT "raw_source_records_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_by_session" ON "events" USING btree ("session_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_machine_connector_record" ON "raw_source_records" USING btree ("machine_id","source_connector","source_record_id");--> statement-breakpoint
CREATE INDEX "raw_by_session" ON "raw_source_records" USING btree ("session_id");