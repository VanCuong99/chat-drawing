CREATE TYPE "public"."asset_status" AS ENUM('pending', 'attached', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('system', 'text', 'image', 'canvas');--> statement-breakpoint
CREATE TYPE "public"."room_kind" AS ENUM('direct', 'group', 'guest');--> statement-breakpoint
CREATE TYPE "public"."room_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "assets" (
	"key" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"owner_key" text NOT NULL,
	"guest_session_id" uuid,
	"status" "asset_status" NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"last_read_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"sender_id" text,
	"guest_session_id" uuid,
	"sender_name" text NOT NULL,
	"type" "message_type" NOT NULL,
	"body" text,
	"asset_key" uuid,
	"reply_to_id" uuid,
	"canvas_parent_id" uuid,
	"canvas_version" integer,
	"created_at" bigint NOT NULL,
	"edited_at" bigint,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"message_id" uuid NOT NULL,
	"actor_key" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "reactions_message_id_actor_key_emoji_pk" PRIMARY KEY("message_id","actor_key","emoji")
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "room_role" NOT NULL,
	"joined_at" bigint NOT NULL,
	"last_read_at" bigint NOT NULL,
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "room_kind" NOT NULL,
	"created_by" text,
	"invite_code" text NOT NULL,
	"allow_guests" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_color" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_room_idx" ON "assets" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "assets_guest_status_idx" ON "assets" USING btree ("guest_session_id","status");--> statement-breakpoint
CREATE INDEX "assets_status_created_idx" ON "assets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "guest_sessions_room_expiry_idx" ON "guest_sessions" USING btree ("room_id","expires_at");--> statement-breakpoint
CREATE INDEX "guest_sessions_expiry_idx" ON "guest_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "messages_room_created_idx" ON "messages" USING btree ("room_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_guest_expiry_idx" ON "messages" USING btree ("guest_session_id","expires_at");--> statement-breakpoint
CREATE INDEX "messages_reply_to_idx" ON "messages" USING btree ("reply_to_id");--> statement-breakpoint
CREATE INDEX "messages_canvas_parent_idx" ON "messages" USING btree ("canvas_parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_asset_key_unique" ON "messages" USING btree ("asset_key");--> statement-breakpoint
CREATE INDEX "reactions_message_idx" ON "reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "reactions_expiry_idx" ON "reactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "room_members_user_room_idx" ON "room_members" USING btree ("user_id","room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_invite_code_unique" ON "rooms" USING btree ("invite_code");--> statement-breakpoint
CREATE INDEX "rooms_created_by_idx" ON "rooms" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");