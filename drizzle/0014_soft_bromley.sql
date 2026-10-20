CREATE TABLE `attachment_blob_fences` (
	`user_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`attachment_id` text NOT NULL,
	`namespace` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL,
	`purged_at` text,
	PRIMARY KEY(`user_id`, `storage_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blob_fence_owner_token` ON `attachment_blob_fences` (`user_id`,`token`);--> statement-breakpoint
CREATE INDEX `blob_fence_owner_attachment` ON `attachment_blob_fences` (`user_id`,`attachment_id`);--> statement-breakpoint
CREATE TABLE `attachment_blob_namespaces` (
	`user_id` text NOT NULL,
	`namespace` text NOT NULL,
	`created_at` text NOT NULL,
	`purpose` text NOT NULL,
	`source_import_id` text,
	PRIMARY KEY(`user_id`, `namespace`)
);
--> statement-breakpoint
CREATE TABLE `attachment_upload_attempts` (
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`attachment_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text,
	PRIMARY KEY(`user_id`, `token`)
);
--> statement-breakpoint
CREATE INDEX `blob_upload_owner_key_pending` ON `attachment_upload_attempts` (`user_id`,`storage_key`,`settled_at`);