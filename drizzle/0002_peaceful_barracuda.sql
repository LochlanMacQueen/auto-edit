CREATE TYPE "scheduler"."pipeline_item_status" AS ENUM('ready', 'publishing', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "scheduler"."pipeline_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_udid" text NOT NULL,
	"status" "scheduler"."pipeline_item_status" DEFAULT 'ready' NOT NULL,
	"caption" text,
	"asset_id" uuid,
	"execution_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scheduler"."pipeline_items" ADD CONSTRAINT "pipeline_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "scheduler"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."pipeline_items" ADD CONSTRAINT "pipeline_items_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "scheduler"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_items_device_status_idx" ON "scheduler"."pipeline_items" USING btree ("device_udid","status","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_items_asset_idx" ON "scheduler"."pipeline_items" USING btree ("asset_id");