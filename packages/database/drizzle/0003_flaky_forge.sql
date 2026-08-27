CREATE TABLE "palette_colors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"guest_session_id" uuid,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"source_a" text NOT NULL,
	"source_b" text NOT NULL,
	"ratio" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "palette_colors" ADD CONSTRAINT "palette_colors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "palette_colors" ADD CONSTRAINT "palette_colors_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "palette_colors_user_created_idx" ON "palette_colors" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "palette_colors_guest_created_idx" ON "palette_colors" USING btree ("guest_session_id","created_at");