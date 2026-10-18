CREATE TABLE `workspace_import_chunks` (
	`user_id` text NOT NULL,
	`import_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`content_base64` text NOT NULL,
	PRIMARY KEY(`user_id`, `import_id`, `ordinal`)
);
--> statement-breakpoint
CREATE TABLE `workspace_imports` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`bytes` integer NOT NULL,
	`metadata_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
