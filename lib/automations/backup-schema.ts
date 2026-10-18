import {sqliteTable,text,integer,primaryKey,index,uniqueIndex} from 'drizzle-orm/sqlite-core';
/** Private recovery bookkeeping. Never a portable module, approval or second queue. */
export const backupArchives=sqliteTable('backup_archives',{
 userId:text('user_id').notNull(),id:text('id').notNull(),namespace:text('namespace').notNull(),intentId:text('intent_id').notNull(),
 sourceRevision:integer('source_revision').notNull(),sourceSha256:text('source_sha256').notNull(),metadataContent:text('metadata_content'),metadataBytes:integer('metadata_bytes').notNull(),
 executionEpoch:integer('execution_epoch').notNull(),status:text('status').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
 zipBytes:integer('zip_bytes').notNull(),files:integer('files').notNull(),fileBytes:integer('file_bytes').notNull(),chunkCount:integer('chunk_count').notNull(),
 indexJson:text('index_json'),indexSha256:text('index_sha256')
},t=>[primaryKey({columns:[t.userId,t.id]}),uniqueIndex('backup_archive_namespace_unique').on(t.namespace),uniqueIndex('backup_archive_owner_intent_unique').on(t.userId,t.intentId),index('backup_archive_owner_status').on(t.userId,t.status)]);
export const backupArchiveObjects=sqliteTable('backup_archive_objects',{
 userId:text('user_id').notNull(),archiveId:text('archive_id').notNull(),partNumber:integer('part_number').notNull(),storageKey:text('storage_key').notNull(),
 bytes:integer('bytes').notNull(),sha256:text('sha256'),createdAt:text('created_at').notNull(),verifiedAt:text('verified_at'),purgedAt:text('purged_at'),
 pendingToken:text('pending_token'),settledAt:text('settled_at')
},t=>[primaryKey({columns:[t.userId,t.archiveId,t.partNumber]}),uniqueIndex('backup_archive_object_key_unique').on(t.storageKey),index('backup_archive_object_owner_charge').on(t.userId,t.purgedAt)]);
