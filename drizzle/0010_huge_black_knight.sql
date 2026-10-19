CREATE TABLE `audit_import_identities` (
	`user_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`source_hash` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `source_identity`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_import_owner_event` ON `audit_import_identities` (`user_id`,`event_id`);