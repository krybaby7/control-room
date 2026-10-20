CREATE TABLE `project_baseline_heads` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`)
);
--> statement-breakpoint
CREATE TABLE `project_baseline_revisions` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`project_id` text NOT NULL,
	`parent_revision_id` text,
	`parent_hash` text NOT NULL,
	`recorded_at` text NOT NULL,
	`source_watermark` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`parent_revision_id`) REFERENCES `project_baseline_revisions`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `baseline_revision_owner_project` ON `project_baseline_revisions` (`user_id`,`project_id`,`recorded_at`);