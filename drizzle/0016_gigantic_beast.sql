CREATE TABLE `attachment_archive_cleanup_claims` (
	`user_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`stage_id` text NOT NULL,
	`namespace` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL,
	`purged_at` text,
	PRIMARY KEY(`user_id`, `storage_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_cleanup_owner_token` ON `attachment_archive_cleanup_claims` (`user_id`,`token`);