CREATE TABLE `workspace_backups` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`reason` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`pinned` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
