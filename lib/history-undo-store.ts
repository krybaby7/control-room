import {z} from 'zod';
import type {SqlDatabase} from './workspace-store.ts';
import {readCurrent} from './workspace-store.ts';
import {ownerReader} from './workspace-modules.ts';
import type {CommandHandler,MutationPlan,PrepareContext} from './workspace-transaction.ts';
import {readAuditCommandGroup,type AuditCommandGroup} from './history-command-group.ts';
import {prepareDecisionUndo} from './history-decision-undo.ts';
import {prepareEvidenceUndo} from './history-evidence-undo.ts';
import {previewPlanningUndo} from './history-undo.ts';
import {parseAuditEvent,topLevelChanges,type AuditEventDraft,type FieldChange,type JsonValue} from './audit-events.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {syncLegacyWeeklyPins} from './planning-module.ts';
import {readReferenceSnapshot,referenceImpact,referenceRegistry} from './workspace-references.ts';
const commandSchema=z.object({type:z.literal('history.undo'),eventId:z.string().min(1).max(128),sourceMutationId:z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),previewHash:z.string().regex(/^[a-f0-9]{64}$/),targetRevision:z.number().int().positive().safe()}).strict();
export interface HistoryUndoPreview {eventId:string;sourceMutationId:string;targetRevision:number;sourceEventIds:string[];changes:FieldChange[];previewHash:string;canUndo:true;blockers:string[];}
function parseGroup(userId:string,values:readonly AuditEventDraft[]):AuditEventDraft[]{
 if(!userId||!values.length||values.length>200)throw new Error('A complete bounded owner command group is required.');const events=values.map(parseAuditEvent);if(new Set(events.map(event=>event.id)).size!==events.length||new TextEncoder().encode(canonical(events)).length>8_000_000)throw new Error('Invalid or oversized undo command group.');for(const event of events)if(event.origin!=='owner'||event.actorId!==userId)throw new Error('Only the authenticated owner’s original command group can be undone.');return events;
}
/** The resolver must return the whole immutable command in ordinal order, never a selected subset. */
export async function prepareHistoryUndoGroup(context:PrepareContext,values:readonly AuditEventDraft[]):Promise<MutationPlan>{
 if(context.command.type!=='history.undo'||context.command.targetRevision!==undefined&&context.command.targetRevision!==context.before.revision)throw new Error('An explicit current-revision undo command is required.');
 const events=parseGroup(context.userId,values);const evidencePlan=await prepareEvidenceUndo(context,events);if(evidencePlan)return evidencePlan;const decisionPlan=await prepareDecisionUndo(context,events);if(decisionPlan)return decisionPlan;let planningAfter=structuredClone(context.before.workspace);for(const event of [...events].reverse())planningAfter=previewPlanningUndo(planningAfter,event,context.now).planningAfter;
 const changes:FieldChange[]=[];for(const collection of ['projects','milestones','tasks','captures'] as const){
  const before=new Map(context.before.workspace[collection].map(row=>[row.id,row])),after=new Map(planningAfter[collection].map(row=>[row.id,row]));
  for(const id of new Set([...before.keys(),...after.keys()])){const previous=before.get(id),next=after.get(id);
   if(!previous||!next){changes.push({path:[collection,id],before:{exists:!!previous,value:previous?structuredClone(previous) as unknown as JsonValue:null},after:{exists:!!next,value:next?structuredClone(next) as unknown as JsonValue:null}});continue;}
   for(const change of topLevelChanges(previous as unknown as Record<string,JsonValue>,next as unknown as Record<string,JsonValue>))changes.push({...change,path:[collection,id,...change.path]});
  }
 }
 if(!changes.length)throw new Error('Command group contains no effective reversible planning changes.');if(changes.length>2000)throw new Error('Undo command exceeds its bounded audit change limit.');
 const snapshot=await readReferenceSnapshot(context.query,referenceRegistry);const target=planningAfter.projects[0]?.id??'history-undo-validation';if(referenceImpact(planningAfter,snapshot,referenceRegistry,{kind:'project',id:target}).dangling.length)throw new Error('Repair dangling normalized references before undo.');
 const selected=typeof context.command.eventId==='string'?context.command.eventId:events[0].id;if(!events.some(event=>event.id===selected))throw new Error('Requested event is outside its complete command group.');
 const undo=parseAuditEvent({id:crypto.randomUUID(),kind:'history.undo',entityType:'command',entityId:null,changes,origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:selected,undoOf:selected});return {planningAfter,writes:await syncLegacyWeeklyPins(context,planningAfter),referenceSnapshot:snapshot,jobs:[],events:[undo]};
}
async function inspect(context:PrepareContext,eventId:string,group:AuditCommandGroup):Promise<{plan:MutationPlan;preview:HistoryUndoPreview}>{
 if(!group.events.some(event=>event.id===eventId))throw new Error('Requested event is outside its complete command group.');z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).parse(group.mutationId);const plan=await prepareHistoryUndoGroup({...context,command:{...context.command,eventId}},group.events);const sourceEventHashes=await Promise.all(group.events.map(async event=>({id:event.id,hash:await contentHash(canonical(parseAuditEvent(event)))})));
 // Server-managed updatedAt is recomputed at commit; the owner revision binds its current value.
 const changes=plan.events.flatMap(event=>event.changes);if(!changes.length||changes.length>2000)throw new Error('Undo exceeds its complete change review limit.');
 const affected=changes.filter(change=>change.path.at(-1)!=='updatedAt').map(change=>{
  if(change.path[0]==='record'&&change.before.exists&&change.after.exists&&change.before.value&&change.after.value&&typeof change.before.value==='object'&&typeof change.after.value==='object'&&!Array.isArray(change.before.value)&&!Array.isArray(change.after.value)){
   const previous=change.before.value.version,next=change.after.value.version;
   if(previous&&next&&typeof previous==='object'&&typeof next==='object'&&!Array.isArray(previous)&&!Array.isArray(next)&&typeof previous.version==='number'&&next.version===previous.version+1){const generated=structuredClone(change);delete ((generated.after.value as Record<string,JsonValue>).version as Record<string,JsonValue>).recordedAt;return generated;}
  }
  if(change.path[0]!=='evidence_versions'||change.before.exists||!change.after.exists||!change.after.value||typeof change.after.value!=='object'||Array.isArray(change.after.value))return change;
  const generated=structuredClone(change);delete (generated.after.value as Record<string,JsonValue>).recordedAt;return generated;
 });
 const previewHash=await contentHash(canonical({type:'history.undo',eventId,sourceMutationId:group.mutationId,targetRevision:context.before.revision,sourceEventHashes,affected,referenceDigest:plan.referenceSnapshot!.digest}));
 return {plan,preview:{eventId,sourceMutationId:group.mutationId,targetRevision:context.before.revision,sourceEventIds:group.events.map(event=>event.id),changes,previewHash,canUndo:true,blockers:[]}};
}
/** Server read-only preview; the authoritative owner and revision must be supplied by the authenticated route. */
export async function previewHistoryUndo(db:SqlDatabase,userId:string,eventId:string,revision:number,now:string):Promise<HistoryUndoPreview>{
 if(!userId||!eventId||eventId.length>128||!Number.isSafeInteger(revision)||revision<1)throw new Error('Invalid owner undo preview target.');const before=await readCurrent(db,userId);if(before.revision!==revision)throw new Error('Undo preview revision changed.');const group=await readAuditCommandGroup(db,userId,eventId);if(!group)throw new Error('Owner history command is unavailable for undo.');const context:PrepareContext={userId,before,command:{type:'history.undo',eventId},now,query:ownerReader(db,userId),async readImport(){throw new Error('Import staging is unavailable in undo preview.');}};const {preview}=await inspect(context,eventId,group);if((await readCurrent(db,userId)).revision!==before.revision)throw new Error('Workspace changed during undo preview.');return preview;
}
export function createHistoryUndoHandler(readGroup?:((eventId:string)=>Promise<AuditCommandGroup|null>)):CommandHandler{return {async prepare(context){
 const command=commandSchema.parse(context.command);if(command.targetRevision!==context.before.revision)throw new Error('Undo preview is stale.');const resolve=readGroup??context.readAuditGroup;if(!resolve)throw new Error('Owner-bound immutable command history is unavailable.');const group=await resolve(command.eventId);if(!group||group.mutationId!==command.sourceMutationId)throw new Error('Original command mutation identity changed or is unavailable.');const {plan,preview}=await inspect(context,command.eventId,group);if(preview.previewHash!==command.previewHash)throw new Error('Undo preview changed. Review the complete command again.');return plan;
}};}
export const historyUndoHandler=createHistoryUndoHandler();
