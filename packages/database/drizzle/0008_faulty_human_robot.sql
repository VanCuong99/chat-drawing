CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" bigint NOT NULL,
	"count" integer NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limits_updated_idx" ON "rate_limits" USING btree ("updated_at");