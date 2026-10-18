CREATE TABLE `attachments` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`workspace_revision` integer,
	`ordinal` integer,
	`stream_id` text,
	`stream_sequence` integer,
	`kind` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`occurred_at` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`),
	CONSTRAINT "audit_one_order_domain" CHECK(("audit_events"."workspace_revision" IS NOT NULL AND "audit_events"."ordinal" IS NOT NULL AND "audit_events"."stream_id" IS NULL AND "audit_events"."stream_sequence" IS NULL) OR ("audit_events"."workspace_revision" IS NULL AND "audit_events"."ordinal" IS NULL AND "audit_events"."stream_id" IS NOT NULL AND "audit_events"."stream_sequence" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_owner_order` ON `audit_events` (`user_id`,`workspace_revision`,`ordinal`) WHERE "audit_events"."workspace_revision" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_stream_order` ON `audit_events` (`user_id`,`stream_id`,`stream_sequence`) WHERE "audit_events"."stream_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `decisions` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `evidence_links` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `evidence_records` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `recurrence_occurrences` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `recurrence_rules` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `weekly_plans` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `weekly_reviews` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_assertions` (
	`user_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "assertion_valid" CHECK("workspace_assertions"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE `workspace_command_guards` (
	`user_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`claim_token` text NOT NULL,
	`valid` integer NOT NULL,
	PRIMARY KEY(`user_id`, `mutation_id`),
	CONSTRAINT "command_claim_valid" CHECK("workspace_command_guards"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE `workspace_configuration` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_job_intents` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`not_before` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intent_dedupe` ON `workspace_job_intents` (`user_id`,`kind`,`dedupe_key`);