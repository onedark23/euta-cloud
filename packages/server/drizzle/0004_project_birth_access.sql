CREATE TABLE "access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"granted_role" text
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "visibility" text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "origin" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "origin_local_id" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_requests_open_uq" ON "access_requests" USING btree ("project_id","user_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "access_requests_project_idx" ON "access_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "access_requests_user_idx" ON "access_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_origin_local_idx" ON "projects" USING btree ("created_by","origin_local_id");