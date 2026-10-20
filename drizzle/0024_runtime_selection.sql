CREATE TABLE `backup_archive_objects` (
	`user_id` text NOT NULL,
	`archive_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`storage_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text,
	`created_at` text NOT NULL,
	`verified_at` text,
	`purged_at` text,
	`pending_token` text,
	`settled_at` text,
	PRIMARY KEY(`user_id`, `archive_id`, `part_number`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_archive_object_key_unique` ON `backup_archive_objects` (`storage_key`);--> statement-breakpoint
CREATE INDEX `backup_archive_object_owner_charge` ON `backup_archive_objects` (`user_id`,`purged_at`);--> statement-breakpoint
CREATE TABLE `backup_archives` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`namespace` text NOT NULL,
	`intent_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`source_sha256` text NOT NULL,
	`metadata_content` text,
	`metadata_bytes` integer NOT NULL,
	`execution_epoch` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`zip_bytes` integer NOT NULL,
	`files` integer NOT NULL,
	`file_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`index_json` text,
	`index_sha256` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_archive_namespace_unique` ON `backup_archives` (`namespace`);--> statement-breakpoint
CREATE UNIQUE INDEX `backup_archive_owner_intent_unique` ON `backup_archives` (`user_id`,`intent_id`);--> statement-breakpoint
CREATE INDEX `backup_archive_owner_status` ON `backup_archives` (`user_id`,`status`);