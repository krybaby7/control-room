-- Individually addressable logical history records, outside the bounded editor document.
-- A closed discriminated codec and owner-bound kind/key indexes share the existing
-- module transaction/export/recovery infrastructure instead of a competing writer.
CREATE TABLE project_history (
 user_id TEXT NOT NULL,
 id TEXT NOT NULL,
 row_revision INTEGER NOT NULL CHECK(row_revision>0),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 content_hash TEXT NOT NULL,
 stream_sequence INTEGER NOT NULL DEFAULT 0 CHECK(stream_sequence>=0),
 PRIMARY KEY(user_id,id)
);
--> statement-breakpoint
CREATE INDEX history_owner_kind ON project_history(user_id,json_extract(payload_json,'$.kind'),id);
--> statement-breakpoint
CREATE INDEX history_owner_source ON project_history(user_id,json_extract(payload_json,'$.value.sourceId'),id);
--> statement-breakpoint
CREATE INDEX history_owner_conversation ON project_history(user_id,json_extract(payload_json,'$.value.conversationId'),id);
--> statement-breakpoint
CREATE INDEX history_owner_area ON project_history(user_id,json_extract(payload_json,'$.value.projectId'),json_extract(payload_json,'$.value.areaId'),id);
--> statement-breakpoint
CREATE INDEX history_owner_sequence ON project_history(user_id,stream_sequence,id);
--> statement-breakpoint

-- Physical private-object accounting is not runnable authorization. A pending PUT
-- never becomes purgeable merely because a lease/timeout elapsed.
CREATE TABLE history_object_ledger (
 user_id TEXT NOT NULL,
 key TEXT NOT NULL,
 source_id TEXT NOT NULL,
 epoch TEXT NOT NULL,
 scope_revision INTEGER NOT NULL CHECK(scope_revision>0),
 sha256 TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=16777216),
 status TEXT NOT NULL CHECK(status IN ('staging','ready','abandoned')),
 pending_token TEXT,
 created_at TEXT NOT NULL,
 verified_at TEXT,
 purged_at TEXT,
 PRIMARY KEY(user_id,key),
 UNIQUE(user_id,pending_token)
);
--> statement-breakpoint
CREATE INDEX history_object_owner_source ON history_object_ledger(user_id,source_id,status);
--> statement-breakpoint

-- Hashed, finite, source/epoch-scoped credentials are never portable authority.
CREATE TABLE history_ingest_credentials (
 user_id TEXT NOT NULL,
 id TEXT NOT NULL,
 secret_hash TEXT NOT NULL,
 source_id TEXT NOT NULL,
 epoch TEXT NOT NULL,
 scope_revision INTEGER NOT NULL,
 execution_epoch INTEGER NOT NULL,
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 PRIMARY KEY(user_id,id),
 UNIQUE(secret_hash)
);
--> statement-breakpoint

-- Native identity is stable across page boundaries and competing imports.
CREATE UNIQUE INDEX history_native_conversation ON project_history(user_id,json_extract(payload_json,'$.value.sourceId'),json_extract(payload_json,'$.value.nativeThreadId')) WHERE json_extract(payload_json,'$.kind')='conversation';
--> statement-breakpoint
CREATE UNIQUE INDEX history_native_message_revision ON project_history(user_id,json_extract(payload_json,'$.value.conversationId'),json_extract(payload_json,'$.value.nativeMessageId'),json_extract(payload_json,'$.value.revisionDigest')) WHERE json_extract(payload_json,'$.kind')='message';
--> statement-breakpoint
