CREATE TABLE `__new_evidence_links` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`row_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`evidence_id` text,
	`evidence_version` integer,
	`subject_type` text,
	`subject_id` text,
	`requirement_id` text,
	`relation` text,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`,`evidence_id`,`evidence_version`) REFERENCES `evidence_versions`(`user_id`,`evidence_id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_evidence_links`("user_id", "id", "row_revision", "payload_json", "content_hash", "evidence_id", "evidence_version", "subject_type", "subject_id", "requirement_id", "relation") SELECT "user_id", "id", "row_revision", "payload_json", "content_hash", "evidence_id", "evidence_version", "subject_type", "subject_id", "requirement_id", "relation" FROM `evidence_links`;--> statement-breakpoint
DROP TABLE `evidence_links`;--> statement-breakpoint
ALTER TABLE `__new_evidence_links` RENAME TO `evidence_links`;--> statement-breakpoint
CREATE INDEX `evidence_link_subject` ON `evidence_links` (`user_id`,`subject_type`,`subject_id`);