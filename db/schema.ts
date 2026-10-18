import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, primaryKey, check, uniqueIndex, index, foreignKey } from 'drizzle-orm/sqlite-core';

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
  userId:text('user_id').notNull(),eventId:text('event_id').notNull(),workspaceRevision:integer('workspace_revision'),ordinal:integer('ordinal'),streamId:text('stream_id'),streamSequence:integer('stream_sequence'),kind:text('kind').notNull(),entityType:text('entity_type').notNull(),entityId:text('entity_id'),occurredAt:text('occurred_at').notNull(),payloadJson:text('payload_json').notNull(),origin:text('origin'),actorId:text('actor_id'),sourceRef:text('source_ref'),undoOf:text('undo_of'),
},table=>[primaryKey({columns:[table.userId,table.eventId]}),index('audit_owner_entity_kind').on(table.userId,table.entityId,table.kind,table.entityType),index('audit_owner_time').on(table.userId,table.occurredAt,table.eventId),index('audit_owner_origin_time').on(table.userId,table.origin,table.occurredAt,table.eventId),uniqueIndex('audit_owner_order').on(table.userId,table.workspaceRevision,table.ordinal).where(sql`${table.workspaceRevision} IS NOT NULL`),uniqueIndex('audit_stream_order').on(table.userId,table.streamId,table.streamSequence).where(sql`${table.streamId} IS NOT NULL`),check('audit_one_order_domain',sql`(${table.workspaceRevision} IS NOT NULL AND ${table.ordinal} IS NOT NULL AND ${table.streamId} IS NULL AND ${table.streamSequence} IS NULL) OR (${table.workspaceRevision} IS NULL AND ${table.ordinal} IS NULL AND ${table.streamId} IS NOT NULL AND ${table.streamSequence} IS NOT NULL)`)]);
export const workspaceJobIntents = sqliteTable('workspace_job_intents', {
  userId:text('user_id').notNull(),id:text('id').notNull(),kind:text('kind').notNull(),dedupeKey:text('dedupe_key').notNull(),payloadJson:text('payload_json').notNull(),notBefore:text('not_before').notNull(),status:text('status').notNull(),executionEpoch:integer('execution_epoch').notNull().default(0),cancelRequested:integer('cancel_requested').notNull().default(0),
},table=>[primaryKey({columns:[table.userId,table.id]}),uniqueIndex('intent_dedupe').on(table.userId,table.kind,table.dedupeKey)]);
function moduleColumns() {return {
  userId:text('user_id').notNull(),id:text('id').notNull(),rowRevision:integer('row_revision').notNull(),payloadJson:text('payload_json').notNull(),contentHash:text('content_hash').notNull(),
};}
function moduleTable(name:string) {return sqliteTable(name,moduleColumns(),table=>[primaryKey({columns:[table.userId,table.id]})]);}
export const weeklyPlans=moduleTable('weekly_plans');
export const weeklyReviews=moduleTable('weekly_reviews');
export const recurrenceRules=moduleTable('recurrence_rules');
export const recurrenceOccurrences=moduleTable('recurrence_occurrences');
// Nullable mirrors preserve every older placeholder payload. New feature handlers
// validate typed values; the transaction compiler writes mirrors with the payload.
export const evidenceRecords=sqliteTable('evidence_records',{...moduleColumns(),currentVersion:integer('current_version'),archivedAt:text('archived_at')},table=>[primaryKey({columns:[table.userId,table.id]}),index('evidence_owner_archive').on(table.userId,table.archivedAt)]);
export const evidenceLinks=sqliteTable('evidence_links',{...moduleColumns(),evidenceId:text('evidence_id'),evidenceVersion:integer('evidence_version'),subjectType:text('subject_type'),subjectId:text('subject_id'),requirementId:text('requirement_id'),relation:text('relation')},table=>[primaryKey({columns:[table.userId,table.id]}),index('evidence_link_subject').on(table.userId,table.subjectType,table.subjectId),foreignKey({columns:[table.userId,table.evidenceId,table.evidenceVersion],foreignColumns:[evidenceVersions.userId,evidenceVersions.evidenceId,evidenceVersions.version]})]);
export const decisions=moduleTable('decisions');
export const attachments=sqliteTable('attachments',{...moduleColumns(),status:text('status'),filename:text('filename'),mimeType:text('mime_type'),expectedBytes:integer('expected_bytes'),actualBytes:integer('actual_bytes'),sha256:text('sha256'),storageKey:text('storage_key'),createdAt:text('created_at'),expiresAt:text('expires_at'),readyAt:text('ready_at'),uploadMutationId:text('upload_mutation_id'),quarantineReason:text('quarantine_reason')},table=>[primaryKey({columns:[table.userId,table.id]}),uniqueIndex('attachment_owner_upload').on(table.userId,table.uploadMutationId).where(sql`${table.uploadMutationId} IS NOT NULL`),uniqueIndex('attachment_owner_key').on(table.userId,table.storageKey).where(sql`${table.storageKey} IS NOT NULL`),index('attachment_owner_status').on(table.userId,table.status)]);
export const workspaceConfiguration=moduleTable('workspace_configuration');
export const evidenceVersions=sqliteTable('evidence_versions',{...moduleColumns(),evidenceId:text('evidence_id').notNull(),version:integer('version').notNull(),recordedAt:text('recorded_at').notNull()},table=>[primaryKey({columns:[table.userId,table.id]}),uniqueIndex('evidence_owner_version').on(table.userId,table.evidenceId,table.version),index('evidence_owner_recorded').on(table.userId,table.recordedAt),foreignKey({columns:[table.userId,table.evidenceId],foreignColumns:[evidenceRecords.userId,evidenceRecords.id]})]);
export const evidenceMappings=moduleTable('evidence_mappings');
export const evidenceRequirements=sqliteTable('evidence_requirements',{...moduleColumns(),subjectType:text('subject_type').notNull(),subjectId:text('subject_id').notNull(),label:text('label').notNull(),scope:text('scope').notNull(),required:integer('required').notNull(),maxAgeDays:integer('max_age_days'),candidate:text('candidate'),requireAttachment:integer('require_attachment').notNull(),archivedAt:text('archived_at')},table=>[primaryKey({columns:[table.userId,table.id]}),index('requirement_owner_subject').on(table.userId,table.subjectType,table.subjectId)]);
export const acceptanceRecords=sqliteTable('acceptance_records',{...moduleColumns(),subjectType:text('subject_type').notNull(),subjectId:text('subject_id').notNull(),decision:text('decision').notNull(),statement:text('statement').notNull(),candidate:text('candidate'),criteriaHash:text('criteria_hash').notNull(),evidenceRefsJson:text('evidence_refs_json').notNull(),recordedAt:text('recorded_at').notNull(),supersedesId:text('supersedes_id')},table=>[primaryKey({columns:[table.userId,table.id]}),index('acceptance_owner_subject').on(table.userId,table.subjectType,table.subjectId,table.recordedAt)]);
export const decisionRecords=sqliteTable('decision_records',{...moduleColumns(),currentVersion:integer('current_version').notNull(),archivedAt:text('archived_at')},table=>[primaryKey({columns:[table.userId,table.id]}),index('decision_owner_archive').on(table.userId,table.archivedAt)]);
export const decisionVersions=sqliteTable('decision_versions',{...moduleColumns(),decisionId:text('decision_id').notNull(),version:integer('version').notNull(),recordedAt:text('recorded_at').notNull(),status:text('status').notNull(),reviewOn:text('review_on'),sourceCaptureId:text('source_capture_id'),supersedesDecisionId:text('supersedes_decision_id')},table=>[primaryKey({columns:[table.userId,table.id]}),uniqueIndex('decision_owner_version').on(table.userId,table.decisionId,table.version),index('decision_owner_review').on(table.userId,table.reviewOn),foreignKey({columns:[table.userId,table.decisionId],foreignColumns:[decisionRecords.userId,decisionRecords.id]})]);
export const attachmentUsage=moduleTable('attachment_usage');
export const auditProjectLinks=sqliteTable('audit_project_links',{userId:text('user_id').notNull(),eventId:text('event_id').notNull(),projectId:text('project_id').notNull()},table=>[primaryKey({columns:[table.userId,table.eventId,table.projectId]}),index('audit_owner_project_event').on(table.userId,table.projectId,table.eventId),foreignKey({columns:[table.userId,table.eventId],foreignColumns:[auditEvents.userId,auditEvents.eventId]})]);
// Private server metadata is deliberately outside all portable data registries.
export const workspaceSourceNamespaces=sqliteTable('workspace_source_namespaces',{userId:text('user_id').primaryKey().notNull(),auditNamespace:text('audit_namespace').notNull(),blobNamespace:text('blob_namespace').notNull(),cursorSecret:text('cursor_secret').notNull()});
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
// Append-only imported claim identity survives bundle changes and recovery; no execution authority.
export const auditImportIdentities=sqliteTable('audit_import_identities',{userId:text('user_id').notNull(),sourceIdentity:text('source_identity').notNull(),sourceHash:text('source_hash').notNull(),eventId:text('event_id').notNull()},table=>[primaryKey({columns:[table.userId,table.sourceIdentity]}),uniqueIndex('audit_import_owner_event').on(table.userId,table.eventId)]);
// Only explicit current-owner commands create grants; imports cannot restore this authority.
export const decisionOwnerGrants=sqliteTable('decision_owner_grants',{userId:text('user_id').notNull(),decisionId:text('decision_id').notNull(),version:integer('version').notNull(),contentHash:text('content_hash').notNull()},table=>[primaryKey({columns:[table.userId,table.decisionId,table.version,table.contentHash]})]);
// Current owner-assessment attribution is server metadata, never restored from portable claims.
export const acceptanceOwnerGrants=sqliteTable('acceptance_owner_grants',{userId:text('user_id').notNull(),recordId:text('record_id').notNull(),contentHash:text('content_hash').notNull()},table=>[primaryKey({columns:[table.userId,table.recordId,table.contentHash]})]);
// Permanent private blob authority survives portable replacement and recovery.
export const attachmentBlobFences=sqliteTable('attachment_blob_fences',{userId:text('user_id').notNull(),storageKey:text('storage_key').notNull(),attachmentId:text('attachment_id').notNull(),namespace:text('namespace').notNull(),token:text('token').notNull(),createdAt:text('created_at').notNull(),purgedAt:text('purged_at')},table=>[primaryKey({columns:[table.userId,table.storageKey]}),uniqueIndex('blob_fence_owner_token').on(table.userId,table.token),index('blob_fence_owner_attachment').on(table.userId,table.attachmentId)]);
// Pending writes never expire merely by elapsed time: a late PUT may still finish.
export const attachmentUploadAttempts=sqliteTable('attachment_upload_attempts',{userId:text('user_id').notNull(),token:text('token').notNull(),attachmentId:text('attachment_id').notNull(),storageKey:text('storage_key').notNull(),createdAt:text('created_at').notNull(),settledAt:text('settled_at')},table=>[primaryKey({columns:[table.userId,table.token]}),index('blob_upload_owner_key_pending').on(table.userId,table.storageKey,table.settledAt)]);
export const attachmentBlobNamespaces=sqliteTable('attachment_blob_namespaces',{userId:text('user_id').notNull(),namespace:text('namespace').notNull(),createdAt:text('created_at').notNull(),purpose:text('purpose').notNull(),sourceImportId:text('source_import_id')},table=>[primaryKey({columns:[table.userId,table.namespace]})]);
// Physical quota includes staged, retired and backup-retained objects until confirmed purge.
export const attachmentBlobObjects=sqliteTable('attachment_blob_objects',{userId:text('user_id').notNull(),storageKey:text('storage_key').notNull(),attachmentId:text('attachment_id').notNull(),namespace:text('namespace').notNull(),bytes:integer('bytes').notNull(),sha256:text('sha256'),createdAt:text('created_at').notNull(),verifiedAt:text('verified_at'),purgedAt:text('purged_at')},table=>[primaryKey({columns:[table.userId,table.storageKey]}),index('blob_objects_owner_quota').on(table.userId,table.purgedAt)]);
export const attachmentArchiveStages=sqliteTable('attachment_archive_stages',{userId:text('user_id').notNull(),id:text('id').notNull(),namespace:text('namespace').notNull(),sourceManifestHash:text('source_manifest_hash').notNull(),manifestJson:text('manifest_json').notNull(),createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),targetRevision:integer('target_revision').notNull(),status:text('status').notNull(),importId:text('import_id'),importHash:text('import_hash')},table=>[primaryKey({columns:[table.userId,table.id]}),uniqueIndex('archive_stage_owner_namespace').on(table.userId,table.namespace)]);
