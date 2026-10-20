CREATE TABLE `workspace_drafts` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_mutation_epochs` (
	`user_id` text NOT NULL,
	`epoch` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text,
	PRIMARY KEY(`user_id`, `epoch`),
	CONSTRAINT "epoch_status" CHECK("workspace_mutation_epochs"."status" IN ('active','retired'))
);
