CREATE TABLE `decision_owner_grants` (
	`user_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `decision_id`, `version`, `content_hash`)
);
