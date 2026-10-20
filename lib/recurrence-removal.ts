import {z} from 'zod';
import type {CommandHandler,PrepareContext} from './workspace-transaction.ts';
import {hashJson} from './workspace-transaction.ts';
import {parsePlanningImport} from './workspace-codec.ts';
import {parseRecurrenceRule,occurrenceTaskId} from './recurrence.ts';
import {recurrenceOccurrenceId,recurrenceOccurrenceSchema,type RecurrenceOccurrence} from './planning-module.ts';
import {readReferenceSnapshot,referenceRegistry,type ReferenceSnapshot} from './workspace-references.ts';
import {previewEntityDeletion,type EntityDeletionPreview} from './workspace-deletion.ts';
import type {JsonValue} from './workspace-protocol.ts';
const inputSchema=z.object({ruleId:z.string().uuid(),occurrenceDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),taskId:z.string().min(1).max(128),expectedOccurrenceRevision:z.number().int().positive().safe()}).strict();
export type OccurrenceRemovalInput=z.infer<typeof inputSchema>;
const commandSchema=z.object({type:z.literal('recurrence.occurrence.remove'),...inputSchema.shape,targetRevision:z.number().int().positive().safe(),previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export interface OccurrenceRemovalPreview extends EntityDeletionPreview,OccurrenceRemovalInput {occurrence:RecurrenceOccurrence;occurrenceHash:string;ruleRevision:number;ruleHash:string;}
async function inspect(context:PrepareContext,input:OccurrenceRemovalInput):Promise<{preview:OccurrenceRemovalPreview;snapshot:ReferenceSnapshot;rowId:string}> {
 if(!context.userId)throw new Error('An authenticated owner is required.');const selection=inputSchema.parse(input);const stableTaskId=occurrenceTaskId(selection.ruleId,selection.occurrenceDate);if(selection.taskId!==stableTaskId)throw new Error('Occurrence task identity differs.');
 const ruleRow=await context.query.get('recurrence_rules',selection.ruleId);if(!ruleRow)throw new Error('Recurrence rule is missing for this owner.');const rule=parseRecurrenceRule(JSON.parse(ruleRow.payload_json));if(rule.id!==ruleRow.id||rule.id!==selection.ruleId)throw new Error('Recurrence rule identity differs.');
 const rowId=recurrenceOccurrenceId(rule.id,selection.occurrenceDate),row=await context.query.get('recurrence_occurrences',rowId);if(!row||row.row_revision!==selection.expectedOccurrenceRevision)throw new Error('Occurrence revision changed or is missing for this owner.');
 const occurrence=recurrenceOccurrenceSchema.parse(JSON.parse(row.payload_json));if(row.id!==rowId||occurrence.ruleId!==rule.id||occurrence.occurrenceDate!==selection.occurrenceDate||occurrence.taskId!==stableTaskId||occurrence.disposition!=='created')throw new Error('Only a created occurrence with its original task can be removed.');
 const snapshot=await readReferenceSnapshot(context.query,referenceRegistry);
 for(const [table,stored] of [['recurrence_rules',ruleRow],['recurrence_occurrences',row]] as const){const found=snapshot.rows.find(item=>item.module===table&&item.id===stored.id);if(!found||found.rowRevision!==stored.row_revision||found.contentHash!==stored.content_hash)throw new Error('Occurrence removal snapshot changed.');}
 let excluded=0;const impactSnapshot:ReferenceSnapshot={...snapshot,rows:snapshot.rows.map(item=>item.module==='recurrence_occurrences'&&item.id===rowId?{...item,references:item.references.filter(ref=>{const own=ref.kind==='task'&&ref.id===selection.taskId&&ref.path.length===1&&ref.path[0]==='taskId';if(own)excluded++;return !own;})}:item)};
 if(excluded!==1)throw new Error('Occurrence reference edge is missing or ambiguous.');
 const deletion=await previewEntityDeletion(context.before.workspace,'task',selection.taskId,context.before.revision,impactSnapshot);
 const previewHash=await hashJson({type:'recurrence.occurrence.remove',selection,targetRevision:context.before.revision,task:deletion.record,fullReferenceDigest:snapshot.digest,rule:{id:ruleRow.id,revision:ruleRow.row_revision,hash:ruleRow.content_hash},occurrence:{id:row.id,revision:row.row_revision,hash:row.content_hash,value:occurrence},impactHash:deletion.previewHash});
 return {preview:{...deletion,...selection,previewHash,occurrence:structuredClone(occurrence),occurrenceHash:row.content_hash,ruleRevision:ruleRow.row_revision,ruleHash:ruleRow.content_hash},snapshot,rowId};
}
/** Read-only preview. The caller's query must already be scoped to its authenticated owner. */
export async function previewOccurrenceRemoval(context:PrepareContext,input:OccurrenceRemovalInput):Promise<OccurrenceRemovalPreview>{return (await inspect(context,input)).preview;}
export const occurrenceRemovalHandler:CommandHandler={async prepare(context){
 const command=commandSchema.parse(context.command);if(context.before.revision!==command.targetRevision)throw new Error('Occurrence removal preview is stale.');
 const {preview,snapshot,rowId}=await inspect(context,{ruleId:command.ruleId,occurrenceDate:command.occurrenceDate,taskId:command.taskId,expectedOccurrenceRevision:command.expectedOccurrenceRevision});if(command.previewHash!==preview.previewHash)throw new Error('Occurrence removal preview changed.');if(!preview.canDelete)throw new Error(preview.blockers.join(' '));
 const planningAfter=structuredClone(context.before.workspace);planningAfter.tasks=planningAfter.tasks.filter(task=>task.id!==command.taskId);const removed:RecurrenceOccurrence={...preview.occurrence,disposition:'removed'};
 return {planningAfter:parsePlanningImport(planningAfter),referenceSnapshot:snapshot,backup:{reason:'delete'},writes:[{table:'recurrence_occurrences',id:rowId,operation:'update',expectedRowRevision:command.expectedOccurrenceRevision,value:removed as unknown as JsonValue}],jobs:[],events:[{id:crypto.randomUUID(),kind:'recurrence.occurrence.remove',entityType:'task',entityId:command.taskId,changes:[{path:['tasks',command.taskId],before:{exists:true,value:preview.record as unknown as JsonValue},after:{exists:false,value:null}},{path:['recurrence_occurrences',rowId],before:{exists:true,value:preview.occurrence as unknown as JsonValue},after:{exists:true,value:removed as unknown as JsonValue}}],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:preview.occurrenceHash,undoOf:null}]};
}};
