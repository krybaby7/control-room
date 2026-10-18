import {deviceDisplaySchema} from './devices/validation.ts';
import {runtimeAdapterConfigurationSchema,selectedRuntimeEvidenceSchema} from './runtime/validation.ts';
import {baselineRevisionSchema} from './baselines/validation.ts';
import {reviewSnapshotSchema,reviewAcknowledgementSchema,notificationEventSchema,notificationPreferencesSchema,analysisPolicySchema,reviewAnalysisSchema} from './reviews/validation.ts';
import {automationScheduleSchema,automationOccurrenceSchema} from './automations/validation.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {sourceConnectionSchema,sourceTargetSchema,sourceObservationSchema,sourceRunHistorySchema,sourceProposalSchema,integrationHistorySchema} from './sources/validation.ts';
import { z } from 'zod';
import { ownerTable, type RegisteredOwnerTable } from './workspace-modules.ts';
import type { JsonValue } from './workspace-protocol.ts';
import { evidenceHeadSchema, evidenceVersionSchema, evidenceLinkSchema, evidenceDateSchema, evidenceIdSchema } from './evidence-validation.ts';
import { decisionVersionSchema } from './decisions.ts';
import { evidenceRequirementSchema } from './evidence-requirements.ts';
import { acceptanceRecordSchema } from './acceptance.ts';
import { versionRowId } from './version-identity.ts';
import { ATTACHMENT_POLICY, validateAttachmentMetadata } from './attachment-policy.ts';
const columns={
 weekly_plans:[],weekly_reviews:[],recurrence_rules:[],recurrence_occurrences:[],
 evidence_records:['current_version','archived_at'],
 evidence_versions:['evidence_id','version','recorded_at'],evidence_mappings:[],
 evidence_links:['evidence_id','evidence_version','subject_type','subject_id','requirement_id','relation'],
 evidence_requirements:['subject_type','subject_id','label','scope','required','max_age_days','candidate','require_attachment','archived_at'],
 acceptance_records:['subject_type','subject_id','decision','statement','candidate','criteria_hash','evidence_refs_json','recorded_at','supersedes_id'],
 decisions:[],decision_records:['current_version','archived_at'],
 decision_versions:['decision_id','version','recorded_at','status','review_on','source_capture_id','supersedes_decision_id'],
 attachments:['status','filename','mime_type','expected_bytes','actual_bytes','sha256','storage_key','created_at','expires_at','ready_at','upload_mutation_id','quarantine_reason'],attachment_usage:[],workspace_configuration:[],
 source_connections:['provider','access_mode','enabled','archived_at'],source_targets:['connection_id','project_id','kind','selection_version','archived_at'],source_observations:['source_id','external_id','source_revision','content_digest','observed_at','stream_sequence'],source_sync_runs:['source_id','finished_at','stream_sequence'],source_proposals:['source_id','state','dedup_key','created_at'],integration_history:['source_id','finished_at','stream_sequence'],
 review_snapshots:['workspace_revision','generated_at','source_watermark','scope_hash','stream_sequence'],review_acknowledgements:['snapshot_id','snapshot_hash','acknowledged_at','scope_hash'],automation_schedules:['kind','enabled','configuration_version','source_id','archived_at'],automation_occurrences:['schedule_id','due_at','finished_at','configuration_hash','stream_sequence'],notification_events:['dedup_key','created_at','kind','severity','source_id','project_id','stream_sequence'],review_settings:['setting_kind'],review_analysis_runs:['snapshot_id','snapshot_hash','started_at','finished_at','status','stream_sequence'],
 project_baseline_revisions:['project_id','parent_revision_id','parent_hash','recorded_at','source_watermark'],
 devices:['created_at','archived_at'],runtime_adapter_configurations:['device_id','project_id','source','instance_id'],runtime_evidence:['device_id','source','received_at','payload_hash'],
} satisfies Record<RegisteredOwnerTable,string[]>;
for(const names of Object.values(columns))Object.freeze(names);
Object.freeze(columns);
export const IMMUTABLE_MODULE_TABLES:ReadonlySet<RegisteredOwnerTable>=new Set(['evidence_versions','decision_versions','acceptance_records','source_observations','source_sync_runs','integration_history','review_snapshots','review_acknowledgements','automation_occurrences','notification_events','review_analysis_runs','project_baseline_revisions','runtime_evidence']);
/** Only these server-owned identifiers may be interpolated by the transaction compiler. */
export function moduleColumnNames(table:RegisteredOwnerTable):readonly string[]{return columns[ownerTable(table)];}
const attachmentSchema=z.object({
 id:evidenceIdSchema,status:z.enum(['reserved','ready','quarantined','deleted']),filename:z.string(),mimeType:z.string(),expectedBytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes),actualBytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes).nullable(),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),storageKey:z.string().min(1).max(512),createdAt:evidenceDateSchema,expiresAt:evidenceDateSchema,readyAt:evidenceDateSchema.nullable(),uploadMutationId:evidenceIdSchema,quarantineReason:z.string().max(1000).nullable(),
}).strict().superRefine((value,ctx)=>{
 try{validateAttachmentMetadata(value);}catch{ctx.addIssue({code:'custom',message:'Invalid attachment metadata.'});}
 if(value.status==='ready'&&(value.actualBytes!==value.expectedBytes||value.sha256===null||value.readyAt===null))ctx.addIssue({code:'custom',message:'Ready attachment metadata is incomplete.'});
});
type Projection=Record<string,string|number|null>;
function matchingId(physical:string,logical:string):void{if(physical!==logical)throw new Error('Module physical ID differs from its logical record.');}
/** Mirrors index typed payloads; a nullable legacy placeholder never becomes typed authority. */
export async function moduleProjection(table:RegisteredOwnerTable,id:string,value:JsonValue):Promise<Projection>{
 const names=moduleColumnNames(table);evidenceIdSchema.parse(id);
 const empty=()=>Object.fromEntries(names.map(name=>[name,null]));
 switch(table){
 case 'devices':{const r=deviceDisplaySchema.parse(value);matchingId(id,r.id);return {created_at:r.createdAt,archived_at:r.archivedAt};}
 case 'runtime_adapter_configurations':{const r=runtimeAdapterConfigurationSchema.parse(value);matchingId(id,r.id);return {device_id:r.deviceId,project_id:r.projectId,source:r.manifest.id,instance_id:r.manifest.endpointAlias};}
 case 'runtime_evidence':{const r=selectedRuntimeEvidenceSchema.parse(value);matchingId(id,r.id);return {device_id:r.deviceId,source:r.source,received_at:r.receivedAt,payload_hash:r.payloadHash};}
 case 'project_baseline_revisions':{const r=baselineRevisionSchema.parse(value);matchingId(id,r.id);return {project_id:r.projectId,parent_revision_id:r.parent.kind==='revision'?r.parent.id:null,parent_hash:r.parent.kind==='revision'?r.parent.hash:r.parent.kind==='bundled'?r.parent.packageHash:r.parent.projectHash,recorded_at:r.recordedAt,source_watermark:r.sourceWatermark};}
 case 'review_snapshots':{const r=reviewSnapshotSchema.parse(value);matchingId(id,r.id);return {workspace_revision:r.workspaceRevision,generated_at:r.generatedAt,source_watermark:r.sourceWatermark,scope_hash:await contentHash(canonical(r.scope)),stream_sequence:0};}
 case 'review_acknowledgements':{const r=reviewAcknowledgementSchema.parse(value);matchingId(id,r.id);return {snapshot_id:r.snapshotId,snapshot_hash:r.snapshotHash,acknowledged_at:r.acknowledgedAt,scope_hash:await contentHash(canonical(r.scope))};}
 case 'automation_schedules':{const r=automationScheduleSchema.parse(value);matchingId(id,r.id);return {kind:r.kind,enabled:r.enabled?1:0,configuration_version:r.configurationVersion,source_id:r.sourceId,archived_at:r.archivedAt};}
 case 'automation_occurrences':{const r=automationOccurrenceSchema.parse(value);matchingId(id,r.id);return {schedule_id:r.scheduleId,due_at:r.dueAt,finished_at:r.finishedAt,configuration_hash:r.configurationHash,stream_sequence:0};}
 case 'notification_events':{const r=notificationEventSchema.parse(value);matchingId(id,r.id);return {dedup_key:r.dedupKey,created_at:r.createdAt,kind:r.kind,severity:r.severity,source_id:r.sourceId,project_id:r.projectId,stream_sequence:0};}
 case 'review_settings':{const r=z.union([notificationPreferencesSchema,analysisPolicySchema]).parse(value);matchingId(id,r.id);return {setting_kind:r.id};}
 case 'review_analysis_runs':{const r=reviewAnalysisSchema.parse(value);matchingId(id,r.id);return {snapshot_id:r.snapshotId,snapshot_hash:r.snapshotHash,started_at:r.startedAt,finished_at:r.finishedAt,status:r.status,stream_sequence:0};}

 case 'source_connections':{const r=sourceConnectionSchema.parse(value);matchingId(id,r.id);return {provider:r.provider,access_mode:r.accessMode,enabled:r.enabled?1:0,archived_at:r.archivedAt};}
 case 'source_targets':{const r=sourceTargetSchema.parse(value);matchingId(id,r.id);return {connection_id:r.connectionId,project_id:r.projectId,kind:r.kind,selection_version:r.selectionVersion,archived_at:r.archivedAt};}
 case 'source_observations':{const r=sourceObservationSchema.parse(value);matchingId(id,r.id);return {source_id:r.sourceId,external_id:r.externalId,source_revision:r.sourceRevision,content_digest:r.contentDigest,observed_at:r.observedAt,stream_sequence:0};}
 case 'source_sync_runs':{const r=sourceRunHistorySchema.parse(value);matchingId(id,r.id);return {source_id:r.sourceId,finished_at:r.finishedAt,stream_sequence:0};}
 case 'source_proposals':{const r=sourceProposalSchema.parse(value);matchingId(id,r.id);return {source_id:r.sourceId,state:r.state,dedup_key:r.dedupKey,created_at:r.createdAt};}
 case 'integration_history':{const r=integrationHistorySchema.parse(value);matchingId(id,r.id);return {source_id:r.sourceId,finished_at:r.finishedAt,stream_sequence:0};}
 case 'evidence_records':case 'decision_records':{
  const parsed=table==='decision_records'?{success:true as const,data:evidenceHeadSchema.parse(value)}:evidenceHeadSchema.safeParse(value);
  if(!parsed.success)return empty();matchingId(id,parsed.data.id);return {current_version:parsed.data.currentVersion,archived_at:parsed.data.archivedAt};
 }
 case 'evidence_versions':{
  const record=evidenceVersionSchema.parse(value);matchingId(id,await versionRowId(record.id,record.version));return {evidence_id:record.id,version:record.version,recorded_at:record.recordedAt};
 }
 case 'decision_versions':{
  const record=decisionVersionSchema.parse(value);matchingId(id,await versionRowId(record.id,record.version));return {decision_id:record.id,version:record.version,recorded_at:record.recordedAt,status:record.status,review_on:record.reviewOn,source_capture_id:record.sourceCaptureId,supersedes_decision_id:record.supersedesDecisionId};
 }
 case 'evidence_links':{
  const parsed=evidenceLinkSchema.safeParse(value);if(!parsed.success)return empty();const record=parsed.data;matchingId(id,record.id);return {evidence_id:record.evidenceId,evidence_version:record.evidenceVersion,subject_type:record.subject.type,subject_id:record.subject.id,requirement_id:record.requirementId,relation:record.relation};
 }
 case 'evidence_requirements':{
  const record=evidenceRequirementSchema.parse(value);matchingId(id,record.id);return {subject_type:record.subject.type,subject_id:record.subject.id,label:record.label,scope:record.scope,required:record.required?1:0,max_age_days:record.maxAgeDays,candidate:record.candidate,require_attachment:record.requireAttachment?1:0,archived_at:record.archivedAt};
 }
 case 'acceptance_records':{
  const record=acceptanceRecordSchema.parse(value);matchingId(id,record.id);return {subject_type:record.subject.type,subject_id:record.subject.id,decision:record.decision,statement:record.statement,candidate:record.candidate,criteria_hash:record.criteriaHash,evidence_refs_json:JSON.stringify(record.evidenceRefs),recorded_at:record.recordedAt,supersedes_id:record.supersedesId};
 }
 case 'attachments':{
  const parsed=attachmentSchema.safeParse(value);if(!parsed.success)return empty();const record=parsed.data;matchingId(id,record.id);return {status:record.status,filename:record.filename,mime_type:record.mimeType,expected_bytes:record.expectedBytes,actual_bytes:record.actualBytes,sha256:record.sha256,storage_key:record.storageKey,created_at:record.createdAt,expires_at:record.expiresAt,ready_at:record.readyAt,upload_mutation_id:record.uploadMutationId,quarantine_reason:record.quarantineReason};
 }
 default:return empty();
 }
}
