CREATE TABLE `personal_repository_state` (
 `user_id` text NOT NULL,
 `id` text NOT NULL,
 `row_revision` integer NOT NULL,
 `payload_json` text NOT NULL,
 `content_hash` text NOT NULL,
 `created_at` text,
 `archived_at` text,
 PRIMARY KEY(`user_id`, `id`)
);

