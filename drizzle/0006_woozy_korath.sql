CREATE TABLE `workspace_execution_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL,
	`restored_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspace_job_intents` ADD `execution_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_job_intents` ADD `cancel_requested` integer DEFAULT 0 NOT NULL;