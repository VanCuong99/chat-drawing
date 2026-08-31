CREATE TYPE "public"."image_purpose" AS ENUM('creative', 'reference');--> statement-breakpoint
CREATE TYPE "public"."visual_status" AS ENUM('exploring', 'needs_changes', 'selected');--> statement-breakpoint
CREATE TABLE "visual_votes" (
	"message_id" uuid NOT NULL,
	"actor_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "visual_votes_message_id_actor_key_pk" PRIMARY KEY("message_id","actor_key")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "image_description" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "image_purpose" "image_purpose" DEFAULT 'creative' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "visual_status" "visual_status" DEFAULT 'exploring' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "decision_owner_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "decided_at" bigint;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "archived_at" bigint;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "invite_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "invite_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "invite_max_uses" integer;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "invite_use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visual_votes" ADD CONSTRAINT "visual_votes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visual_votes_message_idx" ON "visual_votes" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_decision_owner_id_users_id_fk" FOREIGN KEY ("decision_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_decision_owner_idx" ON "messages" USING btree ("decision_owner_id");