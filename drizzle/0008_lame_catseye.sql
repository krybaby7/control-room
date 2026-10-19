CREATE TABLE `acceptance_records` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`decision` text NOT NULL,
	`statement` text NOT NULL,
	`candidate` text,
	`criteria_hash` text NOT NULL,
	`evidence_refs_json` text NOT NULL,
	`recorded_at` text NOT NULL,
	`supersedes_id` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `acceptance_owner_subject` ON `acceptance_records` (`user_id`,`subject_type`,`subject_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `attachment_usage` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `audit_project_links` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`, `project_id`),
	FOREIGN KEY (`user_id`,`event_id`) REFERENCES `audit_events`(`user_id`,`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_owner_project_event` ON `audit_project_links` (`user_id`,`project_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `decision_records` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`current_version` integer NOT NULL,
	`archived_at` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `decision_owner_archive` ON `decision_records` (`user_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `decision_versions` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`decision_id` text NOT NULL,
	`version` integer NOT NULL,
	`recorded_at` text NOT NULL,
	`status` text NOT NULL,
	`review_on` text,
	`source_capture_id` text,
	`supersedes_decision_id` text,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`decision_id`) REFERENCES `decision_records`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decision_owner_version` ON `decision_versions` (`user_id`,`decision_id`,`version`);--> statement-breakpoint
CREATE INDEX `decision_owner_review` ON `decision_versions` (`user_id`,`review_on`);--> statement-breakpoint
CREATE TABLE `evidence_mappings` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `evidence_requirements` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`label` text NOT NULL,
	`scope` text NOT NULL,
	`required` integer NOT NULL,
	`max_age_days` integer,
	`candidate` text,
	`require_attachment` integer NOT NULL,
	`archived_at` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `requirement_owner_subject` ON `evidence_requirements` (`user_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `evidence_versions` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`evidence_id` text NOT NULL,
	`version` integer NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`evidence_id`) REFERENCES `evidence_records`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_owner_version` ON `evidence_versions` (`user_id`,`evidence_id`,`version`);--> statement-breakpoint
CREATE INDEX `evidence_owner_recorded` ON `evidence_versions` (`user_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `workspace_source_namespaces` (
	`user_id` text PRIMARY KEY NOT NULL,
	`audit_namespace` text NOT NULL,
	`blob_namespace` text NOT NULL,
	`cursor_secret` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `attachments` ADD `status` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `filename` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `mime_type` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `expected_bytes` integer;--> statement-breakpoint
ALTER TABLE `attachments` ADD `actual_bytes` integer;--> statement-breakpoint
ALTER TABLE `attachments` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `storage_key` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `expires_at` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `ready_at` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `upload_mutation_id` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `quarantine_reason` text;--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_owner_upload` ON `attachments` (`user_id`,`upload_mutation_id`) WHERE "attachments"."upload_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_owner_key` ON `attachments` (`user_id`,`storage_key`) WHERE "attachments"."storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `attachment_owner_status` ON `attachments` (`user_id`,`status`);--> statement-breakpoint
ALTER TABLE `audit_events` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `actor_id` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `source_ref` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `undo_of` text;--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `evidence_id` text;--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `evidence_version` integer;--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `subject_type` text;--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `subject_id` text;--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `requirement_id` text;--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `relation` text;--> statement-breakpoint
CREATE INDEX `evidence_link_subject` ON `evidence_links` (`user_id`,`subject_type`,`subject_id`);--> statement-breakpoint
ALTER TABLE `evidence_records` ADD `current_version` integer;--> statement-breakpoint
ALTER TABLE `evidence_records` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `evidence_owner_archive` ON `evidence_records` (`user_id`,`archived_at`);
--> statement-breakpoint
-- Preserve original payloads and unknown legacy metadata; only known typed fields are projected.
UPDATE audit_events SET
 origin=CASE WHEN json_valid(payload_json) THEN CASE WHEN json_extract(payload_json,'$.origin') IN ('owner','connector','migration','system') THEN json_extract(payload_json,'$.origin') END END,
 actor_id=CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.actorId')='text' THEN json_extract(payload_json,'$.actorId') END END,
 source_ref=CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.sourceRef')='text' THEN json_extract(payload_json,'$.sourceRef') END END,
 undo_of=CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.undoOf')='text' THEN json_extract(payload_json,'$.undoOf') END END;
--> statement-breakpoint
INSERT OR IGNORE INTO audit_project_links(user_id,event_id,project_id)
 SELECT user_id,event_id,entity_id FROM audit_events WHERE entity_type='project' AND entity_id IS NOT NULL AND length(entity_id) BETWEEN 1 AND 128 AND kind<>'imported-history';
--> statement-breakpoint
INSERT OR IGNORE INTO audit_project_links(user_id,event_id,project_id)
 SELECT audit_events.user_id,audit_events.event_id,j.value FROM audit_events,json_tree(CASE WHEN json_valid(audit_events.payload_json) THEN audit_events.payload_json ELSE '{}' END) j
 WHERE audit_events.kind<>'imported-history' AND j.key='projectId' AND j.type='text' AND length(j.value) BETWEEN 1 AND 128;

--> statement-breakpoint
-- Scalar canonical changes encode projectId in path rather than an object key.
INSERT OR IGNORE INTO audit_project_links(user_id,event_id,project_id)
 SELECT a.user_id,a.event_id,json_extract((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.before.value') FROM audit_events a,
 json_each(CASE WHEN json_valid(a.payload_json) THEN CASE WHEN json_type(a.payload_json,'$.changes')='array' THEN json_extract(a.payload_json,'$.changes') ELSE '[]' END ELSE '[]' END) c
 WHERE a.kind<>'imported-history' AND json_type((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.path')='array'
 AND json_extract((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.path[#-1]')='projectId'
 AND json_type((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.before.value')='text' AND length(json_extract((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.before.value')) BETWEEN 1 AND 128;
--> statement-breakpoint
INSERT OR IGNORE INTO audit_project_links(user_id,event_id,project_id)
 SELECT a.user_id,a.event_id,json_extract((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.after.value') FROM audit_events a,
 json_each(CASE WHEN json_valid(a.payload_json) THEN CASE WHEN json_type(a.payload_json,'$.changes')='array' THEN json_extract(a.payload_json,'$.changes') ELSE '[]' END ELSE '[]' END) c
 WHERE a.kind<>'imported-history' AND json_type((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.path')='array'
 AND json_extract((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.path[#-1]')='projectId'
 AND json_type((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.after.value')='text' AND length(json_extract((CASE WHEN c.type='object' THEN c.value ELSE '{}' END),'$.after.value')) BETWEEN 1 AND 128;
