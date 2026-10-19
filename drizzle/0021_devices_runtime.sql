CREATE TABLE `device_credentials` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`execution_epoch` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`rotation_retire_at` text,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_credential_token` ON `device_credentials` (`token_hash`);--> statement-breakpoint
CREATE TABLE `device_enrollments` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`device_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`execution_epoch` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_enrollment_secret` ON `device_enrollments` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `device_heartbeats` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`boot_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`generation` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`received_at` text NOT NULL,
	`classification` text NOT NULL,
	`receipt_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `device_id`, `boot_id`, `sequence`),
	FOREIGN KEY (`user_id`,`device_id`,`boot_id`) REFERENCES `device_sessions`(`user_id`,`device_id`,`boot_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `device_heartbeat_retention` ON `device_heartbeats` (`user_id`,`device_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `device_live_windows` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`id` text NOT NULL,
	`boot_id` text NOT NULL,
	`generation` integer NOT NULL,
	`sequence` integer NOT NULL,
	`execution_epoch` integer NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	PRIMARY KEY(`user_id`, `device_id`, `id`),
	FOREIGN KEY (`user_id`,`device_id`,`boot_id`) REFERENCES `device_sessions`(`user_id`,`device_id`,`boot_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_window_sequence` ON `device_live_windows` (`user_id`,`device_id`,`boot_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `device_rate_buckets` (
	`bucket_key` text NOT NULL,
	`bucket_at` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`bucket_key`, `bucket_at`)
);
--> statement-breakpoint
CREATE TABLE `device_runtime` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`operational_revision` integer NOT NULL,
	`execution_epoch` integer NOT NULL,
	`current_generation` integer NOT NULL,
	`current_boot_id` text,
	`last_live_received_at` text,
	`revoked_at` text,
	`last_request_at` text,
	PRIMARY KEY(`user_id`, `device_id`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`boot_id` text NOT NULL,
	`generation` integer NOT NULL,
	`execution_epoch` integer NOT NULL,
	`bridge_version` text NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text,
	`compacted_through_sequence` integer DEFAULT 0 NOT NULL,
	`last_window_sequence` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `device_id`, `boot_id`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_generation` ON `device_sessions` (`user_id`,`device_id`,`generation`);--> statement-breakpoint
CREATE TABLE `devices` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`archived_at` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `runtime_adapter_configurations` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`project_id` text,
	`source` text NOT NULL,
	`instance_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_adapter_instance` ON `runtime_adapter_configurations` (`user_id`,`device_id`,`source`,`instance_id`);--> statement-breakpoint
CREATE TABLE `runtime_evidence` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`source` text NOT NULL,
	`received_at` text NOT NULL,
	`payload_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runtime_latest` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`source` text NOT NULL,
	`instance_id` text NOT NULL,
	`generation` integer NOT NULL,
	`sequence` integer NOT NULL,
	`boot_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`receipt_json` text NOT NULL,
	`last_successful_sample_at` text,
	PRIMARY KEY(`user_id`, `device_id`, `source`, `instance_id`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runtime_minute_aggregates` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`source` text NOT NULL,
	`instance_id` text NOT NULL,
	`bucket_at` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `device_id`, `source`, `instance_id`, `bucket_at`),
	FOREIGN KEY (`user_id`,`device_id`) REFERENCES `devices`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runtime_observations` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`boot_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`source` text NOT NULL,
	`instance_id` text NOT NULL,
	`generation` integer NOT NULL,
	`observed_at` text,
	`reported_age_seconds` integer,
	`received_at` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `device_id`, `boot_id`, `sequence`, `source`, `instance_id`),
	FOREIGN KEY (`user_id`,`device_id`,`boot_id`,`sequence`) REFERENCES `device_heartbeats`(`user_id`,`device_id`,`boot_id`,`sequence`) ON UPDATE no action ON DELETE no action
);
