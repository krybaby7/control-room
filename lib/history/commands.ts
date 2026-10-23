import {z} from 'zod';
import {previewHistoryRemoval} from './removal.ts';
import type {CommandHandler,MutationPlan} from '../workspace-transaction.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {historyRecordId,parseHistoryRecord,HistorySourceValueSchema} from './record.ts';
import {HistorySourceKindSchema} from './validation.ts';
const id=z.string().trim().min(1).max(128),label=z.string().trim().min(1).max(200);
const expected=z.number().int().positive().safe();
export const historySourceCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('history.source.configure'),sourceId:id.nullable(),expectedRowRevision:expected.nullable(),kind:HistorySourceKindSchema,scopeLabel:label,roots:z.array(z.string().min(1).max(1000)).max(32),accountId:id.nullable(),deviceId:id.nullable(),includeArchived:z.boolean(),exclusions:z.array(z.string().min(1).max(1000)).max(100)}).strict(),
 z.object({type:z.literal('history.source.remove'),sourceId:id,expectedRowRevision:expected,previewDigest:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(1).max(4000)}).strict(),
 z.object({type:z.enum(['history.source.pause','history.source.resume','history.source.disconnect']),sourceId:id,expectedRowRevision:expected}).strict(),
]);
export type HistorySourceCommand=z.infer<typeof historySourceCommandSchema>;
export const historySourceCommandHandler:CommandHandler={async prepare(ctx):Promise<MutationPlan>{
 const command=historySourceCommandSchema.parse(ctx.command),logical=command.sourceId??crypto.randomUUID();
 const physical=await historyRecordId('source',logical),row=await ctx.query.get('project_history',physical);
 if((row?.row_revision??null)!==command.expectedRowRevision)throw Error('Source configuration revision changed.');
 const before=row?parseHistoryRecord(JSON.parse(row.payload_json)):null;
 if(before&&before.kind!=='source')throw Error('Source configuration identity differs.');
 const previous=before?.kind==='source'?before.value:null;
 if(command.type!=='history.source.configure'&&!previous)throw Error('Source configuration is missing.');
 if(command.type==='history.source.configure'&&command.sourceId===null&&command.expectedRowRevision!==null)throw Error('New source cannot have a prior revision.');
 if(previous&&command.type==='history.source.configure'&&previous.configuration.kind!==command.kind)throw Error('A different provider kind requires a new source identity.');
 if(!ctx.historyRuntime)throw Error('History execution context is unavailable.');
 const executionEpoch=await ctx.historyRuntime.executionEpoch();
 if(!Number.isSafeInteger(executionEpoch)||executionEpoch<0)throw Error('History execution epoch is invalid.');
 if(command.type==='history.source.remove'){
  if(!previous?.paused)throw Error('Pause or disconnect the source before reviewing removal.');
  const preview=await previewHistoryRemoval(ctx.query,logical);
  if(preview.digest!==command.previewDigest)throw Error('Removal impact changed. Review the current preview.');
  const removedEpoch=crypto.randomUUID(),removedScope=previous.scopeRevision+1;
  const next=parseHistoryRecord({id:physical,kind:'source',value:{...previous,executionEpoch,paused:true,removedAt:ctx.now,epoch:removedEpoch,scopeRevision:removedScope,configuration:{...previous.configuration,epoch:removedEpoch,scopeRevision:removedScope}}});
  if(next.kind!=='source')throw Error('Invalid source.');
  next.value.configuration={...next.value.configuration,epoch:next.value.epoch,scopeRevision:next.value.scopeRevision};
  const removalId=crypto.randomUUID(),tombstone=parseHistoryRecord({id:await historyRecordId('source_removal',removalId),kind:'source_removal',value:{id:removalId,sourceId:logical,removedAt:ctx.now,reason:command.reason,impactDigest:preview.digest,counts:preview.counts,retention:'physical_bytes_retained_pending_verified_backup'}});
  return {planningAfter:ctx.before.workspace,historyRemovalRows:preview.rows,writes:[{table:'project_history',id:physical,operation:'update',expectedRowRevision:row!.row_revision,value:next as unknown as JsonValue},{table:'project_history',id:tombstone.id,operation:'insert',expectedRowRevision:null,value:tombstone as unknown as JsonValue}],events:[{id:crypto.randomUUID(),kind:command.type,entityType:'history-source',entityId:logical,changes:[{path:['project_history',physical],before:{exists:true,value:before as unknown as JsonValue},after:{exists:true,value:next as unknown as JsonValue}}],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:null,undoOf:null}],jobs:[{id:crypto.randomUUID(),kind:'area_analysis',dedupeKey:'source-removal:'+removalId,notBefore:ctx.now,payload:{sourceId:logical,removalId}}]};
 }
 if(previous?.removedAt)throw Error('Removed source requires a new explicit enrollment.');
 const epoch=crypto.randomUUID(),scopeRevision=(previous?.scopeRevision??0)+1;
 const configured=command.type==='history.source.configure';
 const configuration=configured?{codecVersion:1 as const,sourceId:logical,kind:command.kind,epoch,scopeRevision,roots:command.roots,accountId:command.accountId,deviceId:command.deviceId,includeArchived:command.includeArchived,exclusions:command.exclusions,parserVersion:'history-v1',normalizationVersion:'unicode-v1'}:{...previous!.configuration,epoch,scopeRevision};
 const capability={sourceId:logical,kind:configuration.kind,scopeLabel:configured?command.scopeLabel:previous!.capability.scopeLabel,inventory:'unverified' as const,contentRead:'unverified' as const,unattendedRead:false,verifiedAt:null,proofRef:null,limitation:command.type==='history.source.disconnect'?'Disconnected; retained history is preserved.':'Selected scope awaits actual inventory, content and unattended verification.'};
 const paused=command.type==='history.source.pause'||command.type==='history.source.disconnect';
 const value=HistorySourceValueSchema.parse({id:logical,configuration,capability,epoch,scopeRevision,executionEpoch,paused,removedAt:null});
 const record=parseHistoryRecord({id:physical,kind:'source',value});
 return {planningAfter:ctx.before.workspace,writes:[{table:'project_history',id:physical,operation:row?'update':'insert',expectedRowRevision:row?.row_revision??null,value:record as unknown as JsonValue}],events:[{id:crypto.randomUUID(),kind:command.type,entityType:'history-source',entityId:logical,changes:[{path:['project_history',physical],before:{exists:!!before,value:before as unknown as JsonValue},after:{exists:true,value:record as unknown as JsonValue}}],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:null,undoOf:null}],jobs:[]};
}};
export const historySourceCommandHandlers=new Map(['history.source.configure','history.source.pause','history.source.resume','history.source.disconnect','history.source.remove'].map(type=>[type,historySourceCommandHandler]));
