CREATE TABLE `integration_history` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_id` text NOT NULL,
	`finished_at` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`source_id`) REFERENCES `source_targets`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `integration_job_attempts` (
	`user_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`execution_epoch` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`outcome` text,
	`failure` text,
	PRIMARY KEY(`user_id`, `intent_id`, `attempt`),
	FOREIGN KEY (`user_id`,`intent_id`) REFERENCES `integration_jobs`(`user_id`,`intent_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `integration_jobs` (
	`user_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`source_id` text NOT NULL,
	`configuration_hash` text NOT NULL,
	`operational_revision` integer DEFAULT 1 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`retry_after` text,
	PRIMARY KEY(`user_id`, `intent_id`),
	FOREIGN KEY (`user_id`,`intent_id`) REFERENCES `workspace_job_intents`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `integration_service_principals` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`renewable_verified_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_principal_token_hash` ON `integration_service_principals` (`token_hash`);--> statement-breakpoint
CREATE TABLE `operational_stream_heads` (
	`user_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`revision` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `stream_id`)
);
--> statement-breakpoint
CREATE TABLE `source_access_grants` (
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`mode` text NOT NULL,
	`principal_ref` text NOT NULL,
	`resource_scope_json` text NOT NULL,
	`verified_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	PRIMARY KEY(`user_id`, `connection_id`, `mode`)
);
--> statement-breakpoint
CREATE TABLE `source_connections` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`provider` text NOT NULL,
	`access_mode` text NOT NULL,
	`enabled` integer NOT NULL,
	`archived_at` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `source_observations` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`content_digest` text NOT NULL,
	`observed_at` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`source_id`) REFERENCES `source_targets`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_observation_identity` ON `source_observations` (`user_id`,`source_id`,`external_id`,`source_revision`,`content_digest`);--> statement-breakpoint
CREATE INDEX `source_observation_owner_stream` ON `source_observations` (`user_id`,`stream_sequence`);--> statement-breakpoint
CREATE TABLE `source_proposals` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_id` text NOT NULL,
	`state` text NOT NULL,
	`dedup_key` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`source_id`) REFERENCES `source_targets`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_proposal_owner_dedup` ON `source_proposals` (`user_id`,`dedup_key`);--> statement-breakpoint
CREATE TABLE `source_sync_runs` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_id` text NOT NULL,
	`finished_at` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`source_id`) REFERENCES `source_targets`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `source_sync_state` (
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`operational_revision` integer NOT NULL,
	`configuration_hash` text NOT NULL,
	`execution_epoch` integer NOT NULL,
	`paused` integer DEFAULT 1 NOT NULL,
	`cursor` text,
	`etag` text,
	`attempted_at` text,
	`last_success_at` text,
	`last_source_revision` text,
	`failure` text,
	`retry_at` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `source_id`)
);
--> statement-breakpoint
CREATE TABLE `source_targets` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`connection_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`selection_version` integer NOT NULL,
	`archived_at` text,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`connection_id`) REFERENCES `source_connections`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_target_owner_project` ON `source_targets` (`user_id`,`project_id`);