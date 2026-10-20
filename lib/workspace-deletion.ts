import { z } from 'zod';
import type { Workspace } from './types.ts';
import { parsePlanningImport, measurePlanning } from './workspace-codec.ts';
import { hashJson, type CommandHandler } from './workspace-transaction.ts';
import {readReferenceSnapshot,referenceRegistry,referenceImpact,type ReferenceSnapshot,type ReferenceImpact} from './workspace-references.ts';
import type { JsonValue } from './workspace-protocol.ts';
import { CommandValidationError } from './workspace-errors.ts';
export type DeletableEntity='project'|'milestone'|'task'|'capture';
const collections={project:'projects',milestone:'milestones',task:'tasks',capture:'captures'} as const;
const commandSchema=z.object({type:z.literal('entity.delete'),entityType:z.enum(['project','milestone','task','capture']),id:z.string().min(1).max(128),previewHash:z.string().regex(/^[a-f0-9]{64}$/),targetRevision:z.number().int().positive().safe()}).strict();
export interface EntityDeletionPreview {
  entityType:DeletableEntity;id:string;targetRevision:number;
  record:Workspace['projects'][number]|Workspace['milestones'][number]|Workspace['tasks'][number]|Workspace['captures'][number];
  references:{collection:'milestones'|'tasks'|'captures';id:string;field:'projectId'|'milestoneId'|'dependsOn'|'convertedTaskId';label?:string}[];
  historicalActivity:{id:string;text:string;projectId:string|null}[];
  normalizedReferences:ReferenceImpact['references'];referenceDigest?:string;
  blockers:string[];canDelete:boolean;previewHash:string;
  beforeCounts:{projects:number;milestones:number;tasks:number;captures:number};afterCounts:{projects:number;milestones:number;tasks:number;captures:number};contentBytesRemoved:number;
}
/** Read-only impact. Caller supplies the authoritative revision, never an imported claim. */
export async function previewEntityDeletion(workspace:Workspace,kind:DeletableEntity,id:string,revision:number,snapshot?:ReferenceSnapshot):Promise<EntityDeletionPreview> {
  if(!['project','milestone','task','capture'].includes(kind) || typeof id!=='string' || !id || !Number.isSafeInteger(revision) || revision<1)throw new CommandValidationError('Invalid deletion target.');
  const parsed=parsePlanningImport(workspace),collection=collections[kind];
  const record=parsed[collection].find(row=>row.id===id);
  if(!record)throw new CommandValidationError('Deletion target does not exist.');
  const references:EntityDeletionPreview['references']=[];
  if(kind==='task') {
    for(const task of parsed.tasks)if(task.dependsOn.includes(id))references.push({collection:'tasks',id:task.id,field:'dependsOn'});
    for(const capture of parsed.captures)if(capture.convertedTaskId===id)references.push({collection:'captures',id:capture.id,field:'convertedTaskId'});
  }
  if(kind==='project'){
    for(const name of ['milestones','tasks','captures'] as const)for(const linked of parsed[name])if(linked.projectId===id)references.push({collection:name,id:linked.id,field:'projectId',label:linked.title});
  }
  if(kind==='milestone')for(const task of parsed.tasks)if(task.milestoneId===id)references.push({collection:'tasks',id:task.id,field:'milestoneId',label:task.title});
  const historicalActivity=kind==='project'?parsed.activity.filter(row=>row.projectId===id).map(({id,text,projectId})=>({id,text,projectId})):[];
  references.sort((a,b)=>a.collection.localeCompare(b.collection)||a.id.localeCompare(b.id)||a.field.localeCompare(b.field));
  const blockers:string[]=[];
  const normalized=snapshot?referenceImpact(parsed,snapshot,referenceRegistry,{kind,id}):{references:[],dangling:[]};
  if(kind==='project'||kind==='milestone'?!('archivedAt' in record)||!record.archivedAt:!('status' in record)||record.status!=='archived')blockers.push('Archive this record before permanently removing it.');
  if(references.length)blockers.push('Other records still reference this record. Reassign or unlink those references explicitly first.');
  if(kind==='capture' && (record as Workspace['captures'][number]).convertedTaskId!==null)blockers.push('Unlink the converted task explicitly before permanently removing this capture.');
  if(normalized.references.length)blockers.push('Normalized records still reference this record. Reassign or unlink those references explicitly first.');
  if(normalized.dangling.length)blockers.push('Normalized records contain dangling references. Repair them before permanent removal.');
  const smaller=structuredClone(parsed);
  if(kind==='project'){smaller.projects=smaller.projects.filter(row=>row.id!==id);smaller.activity=smaller.activity.map(row=>row.projectId===id?{...row,projectId:null}:row);}
  else if(kind==='milestone')smaller.milestones=smaller.milestones.filter(row=>row.id!==id);
  else if(kind==='task')smaller.tasks=smaller.tasks.filter(row=>row.id!==id);else smaller.captures=smaller.captures.filter(row=>row.id!==id);
  // Empty-store previews retain their historical digest; the commit still asserts all empty tables.
  const previewHash=await hashJson({targetRevision:revision,entityType:kind,id,record,references,...(historicalActivity.length?{historicalActivity}:{}),...(snapshot?.rows.length?{referenceDigest:snapshot.digest,normalizedReferences:normalized.references}:{})});
  return {entityType:kind,id,targetRevision:revision,record:structuredClone(record),references,historicalActivity,normalizedReferences:normalized.references,...(snapshot?{referenceDigest:snapshot.digest}:{}),blockers,canDelete:blockers.length===0,previewHash,beforeCounts:{projects:parsed.projects.length,milestones:parsed.milestones.length,tasks:parsed.tasks.length,captures:parsed.captures.length},afterCounts:{projects:smaller.projects.length,milestones:smaller.milestones.length,tasks:smaller.tasks.length,captures:smaller.captures.length},contentBytesRemoved:measurePlanning(parsed).contentBytes-measurePlanning(smaller).contentBytes};
}
export const entityDeleteHandler:CommandHandler={async prepare(context){
  const parsed=commandSchema.safeParse(context.command);
  if(!parsed.success)throw new CommandValidationError('Invalid permanent removal command.');
  const command=parsed.data;
  if(command.targetRevision!==context.before.revision)throw new CommandValidationError('Deletion preview is stale. Refresh and review again.');
  const snapshot=await readReferenceSnapshot(context.query,referenceRegistry);
  const preview=await previewEntityDeletion(context.before.workspace,command.entityType,command.id,context.before.revision,snapshot);
  if(command.previewHash!==preview.previewHash)throw new CommandValidationError('Deletion preview has changed. Refresh and review again.');
  if(!preview.canDelete)throw new CommandValidationError(preview.blockers.join(' '));
  const planningAfter=structuredClone(context.before.workspace),collection=collections[command.entityType];
  if(command.entityType==='project'){planningAfter.projects=planningAfter.projects.filter(row=>row.id!==command.id);planningAfter.activity=planningAfter.activity.map(row=>row.projectId===command.id?{...row,projectId:null}:row);}
  else if(command.entityType==='milestone')planningAfter.milestones=planningAfter.milestones.filter(row=>row.id!==command.id);
  else if(command.entityType==='task')planningAfter.tasks=planningAfter.tasks.filter(row=>row.id!==command.id);else planningAfter.captures=planningAfter.captures.filter(row=>row.id!==command.id);
  return {referenceSnapshot:snapshot,planningAfter:parsePlanningImport(planningAfter),writes:[],jobs:[],backup:{reason:'delete'},events:[{id:crypto.randomUUID(),kind:'entity.delete',entityType:command.entityType,entityId:command.id,changes:[{path:[collection,command.id],before:{exists:true,value:preview.record as unknown as JsonValue},after:{exists:false,value:null}},...preview.historicalActivity.map(row=>({path:['activity',row.id,'projectId'],before:{exists:true,value:row.projectId},after:{exists:true,value:null}}))],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}]};
}};
