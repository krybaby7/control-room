CREATE TABLE `backup_archive_retained_objects` (
	`user_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`source_archive_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`namespace` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`verified_at` text NOT NULL,
	`purged_at` text,
	PRIMARY KEY(`user_id`, `storage_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_archive_retained_key_unique` ON `backup_archive_retained_objects` (`storage_key`);--> statement-breakpoint
CREATE INDEX `backup_archive_retained_owner_charge` ON `backup_archive_retained_objects` (`user_id`,`purged_at`);