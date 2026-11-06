CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"parent_run_id" text,
	"order_index" integer,
	"suite_id" text,
	"suite_name" text,
	"script_id" text,
	"script_path" text,
	"script_version" integer,
	"content_hash" text,
	"script_source" text,
	"environment_id" text,
	"environment_name" text NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"requested_by" text,
	"requested_by_label" text NOT NULL,
	"actor_type" text NOT NULL,
	"credential_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"time_limit_sec" integer NOT NULL,
	"record" jsonb NOT NULL,
	"browser" text,
	"status" text NOT NULL,
	"flaky" boolean DEFAULT false NOT NULL,
	"lease_runner_id" text,
	"lease_expires_at" timestamp with time zone,
	"runner_location" text,
	"credentials_issued_at" timestamp with time zone,
	"stop_requested" text,
	"stop_requested_by" text,
	"engine_run_id" text,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"duration_ms" integer,
	"current_step" jsonb,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"result_files" text DEFAULT 'none' NOT NULL,
	"result_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "run_time_limit_sec" integer DEFAULT 21600 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_suite_id_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."suites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_project_idx" ON "runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_queue_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" USING btree ("parent_run_id","order_index");--> statement-breakpoint
CREATE INDEX "runs_results_idx" ON "runs" USING btree ("result_files","finished_at");