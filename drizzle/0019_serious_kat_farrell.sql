CREATE TABLE `automation_capabilities` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`principal_ref` text NOT NULL,
	`verified_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`proof_kind` text NOT NULL,
	PRIMARY KEY(`user_id`, `kind`, `resource_id`)
);
--> statement-breakpoint
CREATE TABLE `automation_occurrence_claims` (
	`user_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`due_at` text NOT NULL,
	`intent_id` text NOT NULL,
	`configuration_hash` text NOT NULL,
	`execution_epoch` integer NOT NULL,
	`admitted_at` text NOT NULL,
	`missed_periods` integer NOT NULL,
	`principal_ref` text NOT NULL,
	PRIMARY KEY(`user_id`, `schedule_id`, `due_at`),
	FOREIGN KEY (`user_id`,`intent_id`) REFERENCES `workspace_job_intents`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_claim_owner_intent` ON `automation_occurrence_claims` (`user_id`,`intent_id`);--> statement-breakpoint
CREATE TABLE `automation_occurrences` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`schedule_id` text NOT NULL,
	`due_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`configuration_hash` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`schedule_id`) REFERENCES `automation_schedules`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_occurrence_owner_period` ON `automation_occurrences` (`user_id`,`schedule_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `automation_runtime` (
	`user_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`configuration_hash` text NOT NULL,
	`operational_revision` integer NOT NULL,
	`execution_epoch` integer NOT NULL,
	`paused` integer NOT NULL,
	`next_due_at` text NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`failure` text,
	`retry_at` text,
	`principal_ref` text,
	`last_runner_at` text,
	PRIMARY KEY(`user_id`, `schedule_id`)
);
--> statement-breakpoint
CREATE TABLE `automation_schedules` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer NOT NULL,
	`configuration_version` integer NOT NULL,
	`source_id` text,
	`archived_at` text,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`source_id`) REFERENCES `source_targets`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notification_events` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`dedup_key` text NOT NULL,
	`created_at` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`source_id` text,
	`project_id` text,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_owner_dedup` ON `notification_events` (`user_id`,`dedup_key`);--> statement-breakpoint
CREATE TABLE `notification_read_state` (
	`user_id` text NOT NULL,
	`notification_id` text NOT NULL,
	`notification_hash` text NOT NULL,
	`read_at` text NOT NULL,
	`request_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `notification_id`)
);
--> statement-breakpoint
CREATE TABLE `review_ack_grants` (
	`user_id` text NOT NULL,
	`ack_id` text NOT NULL,
	`ack_hash` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `ack_id`)
);
--> statement-breakpoint
CREATE TABLE `review_acknowledgements` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`acknowledged_at` text NOT NULL,
	`scope_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`snapshot_id`) REFERENCES `review_snapshots`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_analysis_consents` (
	`user_id` text NOT NULL,
	`policy_hash` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`max_cost_micros` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	PRIMARY KEY(`user_id`, `policy_hash`)
);
--> statement-breakpoint
CREATE TABLE `review_analysis_requests` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`intent_id` text,
	`snapshot_id` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`policy_hash` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_digest` text NOT NULL,
	`state` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`measured_cost_micros` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`result_id` text,
	`result_hash` text,
	`payload_json` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `review_analysis_runs` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`snapshot_id`) REFERENCES `review_snapshots`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_settings` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`setting_kind` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `review_snapshots` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`workspace_revision` integer NOT NULL,
	`generated_at` text NOT NULL,
	`source_watermark` text NOT NULL,
	`scope_hash` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `review_owner_scope_time` ON `review_snapshots` (`user_id`,`scope_hash`,`generated_at`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_integration_jobs` (
	`user_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`source_id` text,
	`job_subject_kind` text DEFAULT 'source' NOT NULL,
	`subject_id` text,
	`schedule_id` text,
	`schedule_configuration_hash` text,
	`occurrence_due_at` text,
	`configuration_hash` text NOT NULL,
	`operational_revision` integer DEFAULT 1 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`lease_access_mode` text,
	`lease_principal_ref` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`retry_after` text,
	PRIMARY KEY(`user_id`, `intent_id`),
	FOREIGN KEY (`user_id`,`intent_id`) REFERENCES `workspace_job_intents`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "integration_job_subject" CHECK("__new_integration_jobs"."job_subject_kind" IN ('source','review','backup','schedule') AND (("__new_integration_jobs"."job_subject_kind"='source' AND "__new_integration_jobs"."source_id" IS NOT NULL AND ("__new_integration_jobs"."subject_id" IS NULL OR "__new_integration_jobs"."subject_id"="__new_integration_jobs"."source_id")) OR ("__new_integration_jobs"."job_subject_kind"<>'source' AND "__new_integration_jobs"."source_id" IS NULL AND "__new_integration_jobs"."subject_id" IS NOT NULL)))
);
--> statement-breakpoint
INSERT INTO `__new_integration_jobs`("user_id", "intent_id", "source_id", "job_subject_kind", "subject_id", "schedule_id", "schedule_configuration_hash", "occurrence_due_at", "configuration_hash", "operational_revision", "lease_token", "lease_expires_at", "lease_access_mode", "lease_principal_ref", "attempt_count", "retry_after") SELECT "user_id", "intent_id", "source_id", 'source', "source_id", NULL, NULL, NULL, "configuration_hash", "operational_revision", "lease_token", "lease_expires_at", "lease_access_mode", "lease_principal_ref", "attempt_count", "retry_after" FROM `integration_jobs`;--> statement-breakpoint
DROP TABLE `integration_jobs`;--> statement-breakpoint
ALTER TABLE `__new_integration_jobs` RENAME TO `integration_jobs`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;