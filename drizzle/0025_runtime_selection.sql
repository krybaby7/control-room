CREATE TABLE `backup_archive_cleanup_claims` (
	`user_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`archive_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`token` text NOT NULL,
	`claimed_at` text NOT NULL,
	`purged_at` text,
	PRIMARY KEY(`user_id`, `storage_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_archive_cleanup_key_unique` ON `backup_archive_cleanup_claims` (`storage_key`);--> statement-breakpoint
CREATE INDEX `backup_archive_cleanup_owner_archive` ON `backup_archive_cleanup_claims` (`user_id`,`archive_id`);