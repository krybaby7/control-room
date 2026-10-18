import { z } from 'zod';
import type { Workspace } from './types.ts';
import { parsePlanningImport, measurePlanning } from './workspace-codec.ts';
import { hashJson, type CommandHandler } from './workspace-transaction.ts';
import { OWNER_TABLES } from './workspace-modules.ts';
import type { JsonValue } from './workspace-protocol.ts';
import { CommandValidationError } from './workspace-errors.ts';
export type DeletableEntity='task'|'capture';
const commandSchema=z.object({type:z.literal('entity.delete'),entityType:z.enum(['task','capture']),id:z.string().min(1).max(128),previewHash:z.string().regex(/^[a-f0-9]{64}$/),targetRevision:z.number().int().positive().safe()}).strict();
export interface EntityDeletionPreview {
  entityType:DeletableEntity;id:string;targetRevision:number;
  record:Workspace['tasks'][number]|Workspace['captures'][number];
  references:{collection:'tasks'|'captures';id:string;field:'dependsOn'|'convertedTaskId'}[];
  blockers:string[];canDelete:boolean;previewHash:string;
  beforeCounts:{tasks:number;captures:number};afterCounts:{tasks:number;captures:number};contentBytesRemoved:number;
}
/** Read-only impact. Caller supplies the authoritative revision, never an imported claim. */
export async function previewEntityDeletion(workspace:Workspace,kind:DeletableEntity,id:string,revision:number):Promise<EntityDeletionPreview> {
  if(!['task','capture'].includes(kind) || typeof id!=='string' || !id || !Number.isSafeInteger(revision) || revision<1)throw new CommandValidationError('Invalid deletion target.');
  const parsed=parsePlanningImport(workspace),collection=kind==='task'?'tasks':'captures';
  const record=parsed[collection].find(row=>row.id===id);
  if(!record)throw new CommandValidationError('Deletion target does not exist.');
  const references:EntityDeletionPreview['references']=[];
  if(kind==='task') {
    for(const task of parsed.tasks)if(task.dependsOn.includes(id))references.push({collection:'tasks',id:task.id,field:'dependsOn'});
    for(const capture of parsed.captures)if(capture.convertedTaskId===id)references.push({collection:'captures',id:capture.id,field:'convertedTaskId'});
  }
  references.sort((a,b)=>a.collection.localeCompare(b.collection)||a.id.localeCompare(b.id)||a.field.localeCompare(b.field));
  const blockers:string[]=[];
  if(record.status!=='archived')blockers.push('Archive this record before permanently removing it.');
  if(references.length)blockers.push('Other records still reference this task. Remove those references explicitly first.');
  if(kind==='capture' && (record as Workspace['captures'][number]).convertedTaskId!==null)blockers.push('Unlink the converted task explicitly before permanently removing this capture.');
  const smaller=structuredClone(parsed);
  if(kind==='task')smaller.tasks=smaller.tasks.filter(row=>row.id!==id);else smaller.captures=smaller.captures.filter(row=>row.id!==id);
  const previewHash=await hashJson({targetRevision:revision,entityType:kind,id,record,references});
  return {entityType:kind,id,targetRevision:revision,record:structuredClone(record),references,blockers,canDelete:blockers.length===0,previewHash,beforeCounts:{tasks:parsed.tasks.length,captures:parsed.captures.length},afterCounts:{tasks:smaller.tasks.length,captures:smaller.captures.length},contentBytesRemoved:measurePlanning(parsed).contentBytes-measurePlanning(smaller).contentBytes};
}
export const entityDeleteHandler:CommandHandler={async prepare(context){
  const parsed=commandSchema.safeParse(context.command);
  if(!parsed.success)throw new CommandValidationError('Invalid permanent removal command.');
  const command=parsed.data;
  if(command.targetRevision!==context.before.revision)throw new CommandValidationError('Deletion preview is stale. Refresh and review again.');
  const preview=await previewEntityDeletion(context.before.workspace,command.entityType,command.id,context.before.revision);
  if(command.previewHash!==preview.previewHash)throw new CommandValidationError('Deletion preview has changed. Refresh and review again.');
  if(!preview.canDelete)throw new CommandValidationError(preview.blockers.join(' '));
  for(const table of OWNER_TABLES)if((await context.query.list(table,{limit:1})).length)throw new CommandValidationError('Permanent removal is unavailable while normalized records exist without a typed reference adapter.');
  const planningAfter=structuredClone(context.before.workspace),collection=command.entityType==='task'?'tasks':'captures';
  if(command.entityType==='task')planningAfter.tasks=planningAfter.tasks.filter(row=>row.id!==command.id);else planningAfter.captures=planningAfter.captures.filter(row=>row.id!==command.id);
  return {emptyModules:[...OWNER_TABLES],planningAfter:parsePlanningImport(planningAfter),writes:[],jobs:[],backup:{reason:'delete'},events:[{id:crypto.randomUUID(),kind:'entity.delete',entityType:command.entityType,entityId:command.id,changes:[{path:[collection,command.id],before:{exists:true,value:preview.record as unknown as JsonValue},after:{exists:false,value:null}}],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}]};
}};
