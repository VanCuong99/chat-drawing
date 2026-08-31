CREATE TYPE "public"."guest_admission_policy" AS ENUM('off', 'approval', 'link');--> statement-breakpoint
CREATE TYPE "public"."guest_request_status" AS ENUM('pending', 'approved', 'claimed', 'rejected', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "guest_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"invite_code" text NOT NULL,
	"display_name" text NOT NULL,
	"introduction" text,
	"requester_token_hash" text NOT NULL,
	"status" "guest_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"decided_at" bigint,
	"decided_by" text,
	"grant_token_hash" text,
	"grant_expires_at" bigint,
	"invite_use_reserved" boolean DEFAULT false NOT NULL,
	"claimed_guest_session_id" uuid
);
--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "guest_admission_policy" "guest_admission_policy" DEFAULT 'link' NOT NULL;--> statement-breakpoint
UPDATE "rooms" SET "guest_admission_policy" = 'off' WHERE "allow_guests" = false;--> statement-breakpoint
ALTER TABLE "guest_requests" ADD CONSTRAINT "guest_requests_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_requests" ADD CONSTRAINT "guest_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_requests" ADD CONSTRAINT "guest_requests_claimed_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("claimed_guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_requests_requester_token_unique" ON "guest_requests" USING btree ("requester_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_requests_grant_token_unique" ON "guest_requests" USING btree ("grant_token_hash");--> statement-breakpoint
CREATE INDEX "guest_requests_room_status_created_idx" ON "guest_requests" USING btree ("room_id","status","created_at");--> statement-breakpoint
CREATE INDEX "guest_requests_expiry_idx" ON "guest_requests" USING btree ("status","expires_at","grant_expires_at");
