CREATE TABLE `acceptance_owner_grants` (
	`user_id` text NOT NULL,
	`record_id` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `record_id`, `content_hash`)
);
