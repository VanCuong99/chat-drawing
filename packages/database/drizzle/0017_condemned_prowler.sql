ALTER TABLE "messages" ADD COLUMN "canvas_root_id" uuid;--> statement-breakpoint
WITH RECURSIVE "visual_chain"("descendant_id", "current_id", "depth") AS (
	SELECT "id", "canvas_parent_id", 1 FROM "messages" WHERE "canvas_parent_id" IS NOT NULL
	UNION ALL
	SELECT "visual_chain"."descendant_id", "parent"."canvas_parent_id", "visual_chain"."depth" + 1
	FROM "visual_chain"
	JOIN "messages" "parent" ON "parent"."id" = "visual_chain"."current_id"
	WHERE "parent"."canvas_parent_id" IS NOT NULL AND "visual_chain"."depth" < 200
), "visual_roots" AS (
	SELECT DISTINCT ON ("descendant_id") "descendant_id", "current_id" AS "root_id"
	FROM "visual_chain"
	ORDER BY "descendant_id", "depth" DESC
)
UPDATE "messages"
SET "canvas_root_id" = "visual_roots"."root_id"
FROM "visual_roots"
WHERE "messages"."id" = "visual_roots"."descendant_id";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_canvas_root_id_messages_id_fk" FOREIGN KEY ("canvas_root_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_canvas_root_idx" ON "messages" USING btree ("canvas_root_id");
