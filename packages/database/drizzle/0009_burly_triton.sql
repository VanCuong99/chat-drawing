ALTER TABLE "palette_colors" ADD COLUMN "model_id" text DEFAULT 'spectral-kubelka-munk-rgb' NOT NULL;--> statement-breakpoint
ALTER TABLE "palette_colors" ADD COLUMN "model_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "palette_colors" ADD COLUMN "color_space" text DEFAULT 'sRGB' NOT NULL;--> statement-breakpoint
ALTER TABLE "palette_colors" ADD COLUMN "illuminant" text DEFAULT 'D65' NOT NULL;