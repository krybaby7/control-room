CREATE TABLE `attachment_archive_stages` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`namespace` text NOT NULL,
	`source_manifest_hash` text NOT NULL,
	`manifest_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`target_revision` integer NOT NULL,
	`status` text NOT NULL,
	`import_id` text,
	`import_hash` text,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_stage_owner_namespace` ON `attachment_archive_stages` (`user_id`,`namespace`);--> statement-breakpoint
CREATE TABLE `attachment_blob_objects` (
	`user_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`attachment_id` text NOT NULL,
	`namespace` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text,
	`created_at` text NOT NULL,
	`verified_at` text,
	`purged_at` text,
	PRIMARY KEY(`user_id`, `storage_key`)
);
--> statement-breakpoint
CREATE INDEX `blob_objects_owner_quota` ON `attachment_blob_objects` (`user_id`,`purged_at`);
--> statement-breakpoint
-- Preserve known owner-bound object reservations, including retired keys, in physical quota.
INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at)
SELECT a.user_id,a.storage_key,a.id,n.blob_namespace,a.expected_bytes,a.sha256,a.created_at,a.ready_at,NULL
FROM attachments a JOIN workspace_source_namespaces n ON n.user_id=a.user_id
WHERE a.storage_key='attachments/'||n.blob_namespace||'/'||a.id
AND a.expected_bytes BETWEEN 0 AND 20971520 AND a.created_at IS NOT NULL;
--> statement-breakpoint
-- Retained backups may be the last metadata reference to a previously known immutable key.
INSERT OR IGNORE INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at)
SELECT b.user_id,json_extract(r.value,'$.value.storageKey'),json_extract(r.value,'$.id'),n.blob_namespace,json_extract(r.value,'$.value.expectedBytes'),json_extract(r.value,'$.value.sha256'),json_extract(r.value,'$.value.createdAt'),json_extract(r.value,'$.value.readyAt'),NULL
FROM workspace_backups b JOIN workspace_source_namespaces n ON n.user_id=b.user_id
JOIN json_each(CASE WHEN json_valid(b.content) THEN b.content ELSE '{}' END,'$.modules.attachments.records') r
WHERE json_extract(r.value,'$.value.storageKey')='attachments/'||n.blob_namespace||'/'||json_extract(r.value,'$.id')
AND json_extract(r.value,'$.value.expectedBytes') BETWEEN 0 AND 20971520
AND json_extract(r.value,'$.value.createdAt') IS NOT NULL;
--> statement-breakpoint
-- A key is immutable. Conflicting current/retained metadata requires review, never silent undercharging.
INSERT INTO workspace_assertions(user_id,mutation_id,valid)
WITH candidates AS (
SELECT user_id,storage_key,bytes,sha256 FROM attachment_blob_objects
UNION ALL
SELECT b.user_id,json_extract(r.value,'$.value.storageKey'),json_extract(r.value,'$.value.expectedBytes'),json_extract(r.value,'$.value.sha256')
FROM workspace_backups b JOIN workspace_source_namespaces n ON n.user_id=b.user_id
JOIN json_each(CASE WHEN json_valid(b.content) THEN b.content ELSE '{}' END,'$.modules.attachments.records') r
WHERE json_extract(r.value,'$.value.storageKey')='attachments/'||n.blob_namespace||'/'||json_extract(r.value,'$.id')
AND json_extract(r.value,'$.value.expectedBytes') BETWEEN 0 AND 20971520
)
SELECT user_id,'physical-backfill-v1',0 FROM candidates GROUP BY user_id,storage_key
HAVING COUNT(DISTINCT bytes)>1 OR COUNT(DISTINCT sha256)>1;
