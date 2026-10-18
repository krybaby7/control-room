CREATE TABLE `agent_artifacts` (
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`logical_type` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `attempt_id`, `artifact_id`),
	FOREIGN KEY (`user_id`,`attempt_id`) REFERENCES `job_attempts`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_budgets` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`operational_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`maximum_jobs` integer NOT NULL,
	`maximum_seconds` integer NOT NULL,
	`reserved_jobs` integer DEFAULT 0 NOT NULL,
	`reserved_seconds` integer DEFAULT 0 NOT NULL,
	`charged_seconds` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	CONSTRAINT "agent_budget_nonnegative" CHECK("agent_budgets"."maximum_jobs" >= 0 AND "agent_budgets"."maximum_jobs" <= 12 AND "agent_budgets"."maximum_seconds" >= 0 AND "agent_budgets"."maximum_seconds" <= 7200 AND "agent_budgets"."reserved_jobs" >= 0 AND "agent_budgets"."reserved_seconds" >= 0 AND "agent_budgets"."charged_seconds" >= 0 AND "agent_budgets"."enabled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `agent_capabilities` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`reported_at` text NOT NULL,
	`operational_revision` integer NOT NULL,
	`revoked_at` text,
	PRIMARY KEY(`user_id`, `device_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_device_slots` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`reserved_at` text NOT NULL,
	`released_at` text,
	PRIMARY KEY(`user_id`, `device_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_job_state` (
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`status` text NOT NULL,
	`operational_revision` integer NOT NULL,
	`spec_hash` text NOT NULL,
	`task_hash` text NOT NULL,
	`device_id` text,
	`approval_id` text,
	`attempt_id` text,
	`execution_epoch` integer NOT NULL,
	`cancel_requested_at` text,
	`cancel_request_id` text,
	`updated_at` text NOT NULL,
	`result_json` text,
	`accepted_at` text,
	`accepted_task_hash` text,
	PRIMARY KEY(`user_id`, `job_id`),
	CONSTRAINT "agent_state_status" CHECK("agent_job_state"."status" IN ('awaiting_approval','queued','leased','running','cancelling','succeeded','failed','cancelled','blocked','reconcile_required','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_state_owner_intent` ON `agent_job_state` (`user_id`,`intent_id`);--> statement-breakpoint
CREATE INDEX `agent_state_queue` ON `agent_job_state` (`user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `agent_jobs` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`intent_id` text,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`spec_hash` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`intent_id`) REFERENCES `workspace_job_intents`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_job_owner_intent` ON `agent_jobs` (`user_id`,`intent_id`);--> statement-breakpoint
CREATE TABLE `agent_protocol_claims` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`claim_token` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `agent_results` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`job_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_result_attempt` ON `agent_results` (`user_id`,`attempt_id`);--> statement-breakpoint
CREATE INDEX `agent_result_job` ON `agent_results` (`user_id`,`job_id`);--> statement-breakpoint
CREATE TABLE `evaluation_runs` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`run_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`cohort_hash` text NOT NULL,
	`stream_sequence` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `evaluation_owner_device_run` ON `evaluation_runs` (`user_id`,`device_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `job_approvals` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`job_id` text NOT NULL,
	`device_id` text NOT NULL,
	`spec_hash` text NOT NULL,
	`binding_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	`reserved_seconds` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_approval_job` ON `job_approvals` (`user_id`,`job_id`);--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`job_id` text NOT NULL,
	`device_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`execution_epoch` integer NOT NULL,
	`journal_nonce_hash` text NOT NULL,
	`lease_token_hash` text NOT NULL,
	`lease_expires_at` text NOT NULL,
	`deadline_at` text NOT NULL,
	`created_at` text NOT NULL,
	`launched_at` text,
	`exited_at` text,
	`cancel_acknowledged_at` text,
	`last_applied_sequence` integer DEFAULT 0 NOT NULL,
	`operational_revision` integer NOT NULL,
	`identity_json` text NOT NULL,
	`result_json` text,
	`reconciled_at` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_single_attempt_job` ON `job_attempts` (`user_id`,`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_journal_nonce` ON `job_attempts` (`user_id`,`device_id`,`journal_nonce_hash`);--> statement-breakpoint
CREATE INDEX `agent_attempt_expiry` ON `job_attempts` (`user_id`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`sequence` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`receipt_json` text NOT NULL,
	`received_at` text NOT NULL,
	`applied_at` text,
	PRIMARY KEY(`user_id`, `attempt_id`, `epoch`, `sequence`),
	FOREIGN KEY (`user_id`,`attempt_id`) REFERENCES `job_attempts`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
