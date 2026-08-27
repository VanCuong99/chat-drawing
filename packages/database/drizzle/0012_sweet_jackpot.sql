ALTER TABLE "guest_sessions" DROP COLUMN "last_read_at";--> statement-breakpoint
ALTER TABLE "guest_sessions" DROP COLUMN "last_read_message_id";--> statement-breakpoint
ALTER TABLE "room_members" DROP COLUMN "last_read_at";--> statement-breakpoint
ALTER TABLE "room_members" DROP COLUMN "last_read_message_id";