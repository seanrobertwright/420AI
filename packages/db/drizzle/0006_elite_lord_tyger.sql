CREATE TABLE "alert_firings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"alert_key" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"machine_id" uuid,
	"machine_name" text,
	"connector" text,
	"since" text,
	"status" text DEFAULT 'open' NOT NULL,
	"first_fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "machine_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"queue_pending" integer NOT NULL,
	"queue_inflight" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_firings" ADD CONSTRAINT "alert_firings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_firings" ADD CONSTRAINT "alert_firings_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" ADD CONSTRAINT "machine_heartbeats_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_firings_open_key" ON "alert_firings" USING btree ("user_id","alert_key") WHERE "alert_firings"."status" = 'open';--> statement-breakpoint
CREATE INDEX "alert_firings_by_user_status" ON "alert_firings" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "machine_heartbeats_by_machine_ts" ON "machine_heartbeats" USING btree ("machine_id","ts");