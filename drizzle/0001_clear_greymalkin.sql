CREATE TABLE `workspace_mutations` (
	`user_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`command_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`committed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `mutation_id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_recovery` (
	`user_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL
);
