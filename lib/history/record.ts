import {z} from 'zod';
import * as V from './validation.ts';
import {contentHash} from '../canonical-json.ts';
export const historyRecordKinds=['source','source_removal','conversation','message','segment','attachment','gap','alias','ingest_page','cursor','sync_run','claim','work_item','work_item_event','story','roadmap_scope','roadmap_head','checkpoint_assessment','association_rule','repository_evidence','inventory_membership','analysis_checkpoint'] as const;
export type HistoryRecordKind=typeof historyRecordKinds[number];
const id=z.string().min(1).max(1024),count=z.number().int().nonnegative().safe(),clock=z.string().datetime({offset:true});
export const HistorySourceValueSchema=z.object({id,configuration:V.SourceConfigurationSchema,capability:V.SourceCapabilitySchema,epoch:id,scopeRevision:z.number().int().positive().safe(),executionEpoch:count,paused:z.boolean(),removedAt:clock.nullable()}).strict().refine(v=>v.id===v.configuration.sourceId&&v.id===v.capability.sourceId&&v.epoch===v.configuration.epoch&&v.scopeRevision===v.configuration.scopeRevision&&v.configuration.kind===v.capability.kind,'Source configuration identity differs');
export const HistorySourceRemovalValueSchema=z.object({id,sourceId:id,removedAt:clock,reason:z.string().min(1).max(4000),impactDigest:V.digest,counts:z.object({conversations:count,messages:count,claims:count,stories:count,assessments:count}).strict(),retention:z.literal('physical_bytes_retained_pending_verified_backup')}).strict();
export type HistorySourceValue=z.infer<typeof HistorySourceValueSchema>;
const generation={sourceId:id,epoch:id,scopeRevision:z.number().int().positive().safe(),executionEpoch:count};
export const HistoryCursorValueSchema=z.object({...generation,cursor:id.nullable(),watermark:count,lastPageId:id,runId:id}).strict();
export const HistoryRunValueSchema=z.object({...generation,id,inventoryExhausted:z.boolean(),lastPageId:id,watermark:count,updatedAt:clock}).strict();
export const HistoryReceiptValueSchema=z.object({acknowledgement:V.IngestReceiptSchema,executionEpoch:count,runId:id}).strict();
export const HistoryRoadmapHeadValueSchema=z.object({id,projectId:id,areaId:id,scopeRevision:z.number().int().positive().safe(),agreedAt:clock.nullable()}).strict();
export const HistoryAliasValueSchema=z.object({id,sourceId:id,fromConversationId:id,toConversationId:id,reason:z.string().min(1).max(4000),recordedAt:clock}).strict();
const schemas={source:HistorySourceValueSchema,source_removal:HistorySourceRemovalValueSchema,conversation:V.ConversationRecordSchema,message:V.MessageRevisionSchema,segment:V.HistorySegmentSchema,attachment:V.HistoryAttachmentSchema,gap:V.HistoryGapSchema,alias:HistoryAliasValueSchema,ingest_page:HistoryReceiptValueSchema,cursor:HistoryCursorValueSchema,sync_run:HistoryRunValueSchema,claim:V.HistoryClaimSchema,work_item:V.HistoryWorkItemSchema,work_item_event:V.WorkItemEventSchema,story:V.AreaStorySchema,roadmap_scope:V.RoadmapScopeSchema,roadmap_head:HistoryRoadmapHeadValueSchema,checkpoint_assessment:V.CheckpointAcceptanceSchema,association_rule:V.AssociationRuleSchema,repository_evidence:V.RepositoryEvidenceSnapshotSchema,inventory_membership:V.InventoryMembershipSchema,analysis_checkpoint:V.AnalysisCheckpointSchema};
export type HistoryRecordValue<K extends HistoryRecordKind>=z.infer<(typeof schemas)[K]>;
export type HistoryRecord<K extends HistoryRecordKind=HistoryRecordKind>=K extends HistoryRecordKind?{id:string;kind:K;value:HistoryRecordValue<K>}:never;
export async function historyRecordId(kind:HistoryRecordKind,logicalId:string):Promise<string>{z.enum(historyRecordKinds).parse(kind);id.parse(logicalId);return `${kind}:${await contentHash(logicalId)}`;}
export function parseHistoryRecord(input:unknown):HistoryRecord{
 const raw=z.object({id:z.string().min(1).max(128),kind:z.enum(historyRecordKinds),value:z.unknown()}).strict().parse(input);
 if(!raw.id.startsWith(raw.kind+':')||! /^[a-f0-9]{64}$/u.test(raw.id.slice(raw.kind.length+1)))throw Error('History record ID and kind differ.');
 const value=schemas[raw.kind].parse(raw.value);
 return {...raw,value} as HistoryRecord;
}
/** Closed portable codec; owner identity and credentials are never payload fields. */
export const HistoryRecordSchema=z.unknown().transform((value,ctx)=>{try{return parseHistoryRecord(value);}catch{ctx.addIssue({code:'custom',message:'Invalid normalized history record.'});return z.NEVER;}});
