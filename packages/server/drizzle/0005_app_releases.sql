CREATE TABLE "app_release_files" (
	"release_id" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"sha512" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_release_files_release_id_name_pk" PRIMARY KEY("release_id","name")
);
--> statement-breakpoint
CREATE TABLE "app_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"channel" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_release_files" ADD CONSTRAINT "app_release_files_release_id_app_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."app_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_releases_version_uq" ON "app_releases" USING btree ("version");--> statement-breakpoint
CREATE INDEX "app_releases_channel_idx" ON "app_releases" USING btree ("channel","status","published_at");