CREATE TABLE "room_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"reporter_id" text,
	"guest_session_id" uuid,
	"reported_user_id" text,
	"message_id" uuid,
	"reason" text NOT NULL,
	"details" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "room_reports_single_reporter_check" CHECK (("room_reports"."reporter_id" is not null) <> ("room_reports"."guest_session_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"blocker_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "user_blocks_not_self_check" CHECK ("user_blocks"."blocker_id" <> "user_blocks"."blocked_id")
);
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN "muted_at" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "muted_at" bigint;--> statement-breakpoint
ALTER TABLE "room_reports" ADD CONSTRAINT "room_reports_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reports" ADD CONSTRAINT "room_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reports" ADD CONSTRAINT "room_reports_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reports" ADD CONSTRAINT "room_reports_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reports" ADD CONSTRAINT "room_reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_reports_room_created_idx" ON "room_reports" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "room_reports_reporter_idx" ON "room_reports" USING btree ("reporter_id","created_at");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_idx" ON "user_blocks" USING btree ("blocked_id");