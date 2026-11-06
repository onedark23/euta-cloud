ALTER TABLE "runs" ADD COLUMN "always_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "suites" ADD COLUMN "always_run" jsonb DEFAULT '[]'::jsonb NOT NULL;