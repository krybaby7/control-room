import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, primaryKey, check, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  userId: text('user_id').primaryKey().notNull(),
  content: text('content').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workspaceMutations = sqliteTable('workspace_mutations', {
  userId: text('user_id').notNull(),
  mutationId: text('mutation_id').notNull(),
  commandHash: text('command_hash').notNull(),
  revision: integer('revision').notNull(),
  committedAt: text('committed_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.mutationId] })]);

export const workspaceRecovery = sqliteTable('workspace_recovery', {
  userId: text('user_id').primaryKey().notNull(),
  content: text('content').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workspaceCommandGuards = sqliteTable('workspace_command_guards', {
  userId: text('user_id').notNull(), mutationId: text('mutation_id').notNull(), claimToken: text('claim_token').notNull(), valid: integer('valid').notNull(),
}, table => [primaryKey({columns:[table.userId,table.mutationId]}), check('command_claim_valid',sql`${table.valid} = 1`)]);
export const workspaceAssertions = sqliteTable('workspace_assertions', {
  userId:text('user_id').notNull(),mutationId:text('mutation_id').notNull(),valid:integer('valid').notNull(),
},table=>[check('assertion_valid',sql`${table.valid} = 1`)]);
export const auditEvents = sqliteTable('audit_events', {
  userId:text('user_id').notNull(),eventId:text('event_id').notNull(),workspaceRevision:integer('workspace_revision'),ordinal:integer('ordinal'),streamId:text('stream_id'),streamSequence:integer('stream_sequence'),kind:text('kind').notNull(),entityType:text('entity_type').notNull(),entityId:text('entity_id'),occurredAt:text('occurred_at').notNull(),payloadJson:text('payload_json').notNull(),
},table=>[primaryKey({columns:[table.userId,table.eventId]}),uniqueIndex('audit_owner_order').on(table.userId,table.workspaceRevision,table.ordinal).where(sql`${table.workspaceRevision} IS NOT NULL`),uniqueIndex('audit_stream_order').on(table.userId,table.streamId,table.streamSequence).where(sql`${table.streamId} IS NOT NULL`),check('audit_one_order_domain',sql`(${table.workspaceRevision} IS NOT NULL AND ${table.ordinal} IS NOT NULL AND ${table.streamId} IS NULL AND ${table.streamSequence} IS NULL) OR (${table.workspaceRevision} IS NULL AND ${table.ordinal} IS NULL AND ${table.streamId} IS NOT NULL AND ${table.streamSequence} IS NOT NULL)`)]);
export const workspaceJobIntents = sqliteTable('workspace_job_intents', {
  userId:text('user_id').notNull(),id:text('id').notNull(),kind:text('kind').notNull(),dedupeKey:text('dedupe_key').notNull(),payloadJson:text('payload_json').notNull(),notBefore:text('not_before').notNull(),status:text('status').notNull(),executionEpoch:integer('execution_epoch').notNull().default(0),cancelRequested:integer('cancel_requested').notNull().default(0),
},table=>[primaryKey({columns:[table.userId,table.id]}),uniqueIndex('intent_dedupe').on(table.userId,table.kind,table.dedupeKey)]);
function moduleTable(name:string) {return sqliteTable(name,{
  userId:text('user_id').notNull(),id:text('id').notNull(),rowRevision:integer('row_revision').notNull(),payloadJson:text('payload_json').notNull(),contentHash:text('content_hash').notNull(),
},table=>[primaryKey({columns:[table.userId,table.id]})]);}
export const weeklyPlans=moduleTable('weekly_plans');
export const weeklyReviews=moduleTable('weekly_reviews');
export const recurrenceRules=moduleTable('recurrence_rules');
export const recurrenceOccurrences=moduleTable('recurrence_occurrences');
export const evidenceRecords=moduleTable('evidence_records');
export const evidenceLinks=moduleTable('evidence_links');
export const decisions=moduleTable('decisions');
export const attachments=moduleTable('attachments');
export const workspaceConfiguration=moduleTable('workspace_configuration');
export const workspaceDrafts=sqliteTable('workspace_drafts',{
  userId:text('user_id').notNull(),id:text('id').notNull(),rowRevision:integer('row_revision').notNull(),payloadJson:text('payload_json').notNull(),expiresAt:text('expires_at').notNull(),
},table=>[primaryKey({columns:[table.userId,table.id]})]);
export const workspaceMutationEpochs=sqliteTable('workspace_mutation_epochs',{
  userId:text('user_id').notNull(),epoch:text('epoch').notNull(),status:text('status').notNull(),createdAt:text('created_at').notNull(),retiredAt:text('retired_at'),
},table=>[primaryKey({columns:[table.userId,table.epoch]}),check('epoch_status',sql`${table.status} IN ('active','retired')`)]);
export const workspaceBackups=sqliteTable('workspace_backups',{
 userId:text('user_id').notNull(),id:text('id').notNull(),sourceRevision:integer('source_revision').notNull(),createdAt:text('created_at').notNull(),reason:text('reason').notNull(),bytes:integer('bytes').notNull(),sha256:text('sha256').notNull(),content:text('content').notNull(),status:text('status').notNull(),pinned:integer('pinned').notNull(),
},table=>[primaryKey({columns:[table.userId,table.id]})]);
export const workspaceImports=sqliteTable('workspace_imports',{
 userId:text('user_id').notNull(),id:text('id').notNull(),contentHash:text('content_hash').notNull(),createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),bytes:integer('bytes').notNull(),metadataJson:text('metadata_json').notNull(),
},table=>[primaryKey({columns:[table.userId,table.id]})]);
export const workspaceImportChunks=sqliteTable('workspace_import_chunks',{
 userId:text('user_id').notNull(),importId:text('import_id').notNull(),ordinal:integer('ordinal').notNull(),contentBase64:text('content_base64').notNull(),
},table=>[primaryKey({columns:[table.userId,table.importId,table.ordinal]})]);

export const workspaceExecutionState=sqliteTable('workspace_execution_state',{
 userId:text('user_id').primaryKey().notNull(),epoch:integer('epoch').notNull(),restoredAt:text('restored_at').notNull(),
});
