CREATE TABLE "realtime_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"available_at" bigint NOT NULL,
	"locked_until" bigint,
	"worker_id" uuid,
	"published_at" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
DROP INDEX "messages_room_created_idx";--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN "last_read_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sequence" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "messages_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "last_read_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "room_members" AS reader
SET "last_read_sequence" = COALESCE((
	SELECT MAX(message."sequence")
	FROM "messages" AS message
	WHERE message."room_id" = reader."room_id"
		AND (message."created_at" < reader."last_read_at"
			OR (message."created_at" = reader."last_read_at" AND reader."last_read_message_id" IS NOT NULL AND message."id" <= reader."last_read_message_id"))
), 0);--> statement-breakpoint
UPDATE "guest_sessions" AS reader
SET "last_read_sequence" = COALESCE((
	SELECT MAX(message."sequence")
	FROM "messages" AS message
	WHERE message."room_id" = reader."room_id"
		AND (message."created_at" < reader."last_read_at"
			OR (message."created_at" = reader."last_read_at" AND reader."last_read_message_id" IS NOT NULL AND message."id" <= reader."last_read_message_id"))
), 0);--> statement-breakpoint
CREATE INDEX "realtime_outbox_delivery_idx" ON "realtime_outbox" USING btree ("published_at","available_at","locked_until");--> statement-breakpoint
CREATE INDEX "realtime_outbox_created_idx" ON "realtime_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_room_sequence_unique" ON "messages" USING btree ("room_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_request_unique" ON "messages" USING btree ("client_request_id");
