import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import type {CommandHandler,MutationPlan,PrepareContext} from '../workspace-transaction.ts';
import type {ModuleRow,RowPrecondition} from '../workspace-modules.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {AssociationRuleSchema} from './validation.ts';
import {historyRecordId,parseHistoryRecord,type HistoryRecord} from './record.ts';
import {associationTarget,canonicalRepositoryIdentity} from './association.ts';

const id=z.string().min(1).max(128).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
export const historyAssociationCommandSchema=z.object({
 type:z.literal('history.association.set'),scope:z.enum(['conversation','repository','messages']),
 targetIds:z.array(z.string().min(1).max(1024)).min(1).max(100),projectId:id,areaId:id.nullable(),
 expectedRowRevision:z.number().int().positive().safe().nullable(),reason:z.string().trim().min(1).max(4000),
}).strict();
export type HistoryAssociationCommand=z.infer<typeof historyAssociationCommandSchema>;
type Scope=HistoryAssociationCommand['scope'];
function targets(scope:Scope,values:readonly string[]):string[]{
 const result=values.map(value=>{
  let pair:unknown;try{pair=JSON.parse(value);}catch{throw Error('Association targets must be source-qualified JSON pairs.');}
  const [sourceId,target]=z.tuple([id,z.string().min(1).max(512)]).parse(pair);
  if(scope==='repository'){
   if(target.trim()!==target)throw Error('Repository identity must be explicit and canonicalizable.');
   const repository=canonicalRepositoryIdentity(target);if(!repository)throw Error('Repository identity is invalid.');return associationTarget(sourceId,repository);
  }
  return associationTarget(sourceId,id.parse(target));
 }).sort();
 if(new Set(result).size!==result.length)throw Error('Association targets must be unique after normalization.');
 return result;
}
/** Same target set has one stable rule identity, independent of selection order. */
export async function associationRuleId(scope:Scope,targetIds:readonly string[]):Promise<string>{
 return contentHash(canonical({scope,targetIds:targets(scope,targetIds)}));
}
async function decode(row:ModuleRow):Promise<HistoryRecord>{
 const record=parseHistoryRecord(JSON.parse(row.payload_json));
 if('id'in record.value&&typeof record.value.id==='string'&&await historyRecordId(record.kind,record.value.id)!==row.id)throw Error('Retained history logical identity differs.');
 if(record.id!==row.id||await contentHash(canonical(record))!==row.content_hash)throw Error('Retained history integrity differs.');
 return record;
}
/** No source-derived identity or title can grant a mapping. This handler records
 * an explicit owner choice; native provenance grants are compiled by the root. */
export const historyAssociationCommandHandler:CommandHandler={async prepare(ctx):Promise<MutationPlan>{
 const command=historyAssociationCommandSchema.parse(ctx.command);
 if(!ctx.mutationId||!/^[A-Za-z0-9_-]{16,128}$/u.test(ctx.mutationId))throw Error('Owner mutation provenance is required.');
 const project=ctx.before.workspace.projects.find(row=>row.id===command.projectId);
 if(!project||project.archivedAt)throw Error('Select an active owner project.');
 if(command.areaId!==null&&!ctx.before.workspace.areas?.some(row=>row.id===command.areaId&&row.projectId===project.id&&!row.archivedAt))throw Error('Select an active area in this project.');
 const targetIds=targets(command.scope,command.targetIds),logical=await associationRuleId(command.scope,targetIds),physical=await historyRecordId('association_rule',logical);
 const previousRow=await ctx.query.get('project_history',physical),previous=previousRow?await decode(previousRow):null;
 if(previous&&(previous.kind!=='association_rule'||previous.value.id!==logical||previous.value.scope!==command.scope||canonical(targets(command.scope,previous.value.targetIds))!==canonical(targetIds)))throw Error('Association rule identity differs.');
 if((previousRow?.row_revision??null)!==command.expectedRowRevision)throw Error('Association rule revision changed.');
 const preconditions=new Map<string,RowPrecondition>();
 const retain=(row:ModuleRow)=>preconditions.set(row.id,{table:'project_history',id:row.id,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});
 const cached=new Map<string,HistoryRecord>();
 async function owned(kind:'source'|'conversation'|'message',logicalId:string){
  const key=await historyRecordId(kind,logicalId);if(cached.has(key))return cached.get(key)!;
  const row=await ctx.query.get('project_history',key);if(!row)throw Error('Association target is unavailable for this owner.');
  const record=await decode(row);if(record.kind!==kind||!('id'in record.value)||record.value.id!==logicalId)throw Error('Association target identity differs.');
  retain(row);cached.set(key,record);return record;
 }
 const pairs=targetIds.map(value=>JSON.parse(value) as [string,string]);
 for(const [sourceId,target]of pairs){
  const source=await owned('source',sourceId);if(source.kind!=='source')throw Error('Source identity differs.');
  if(command.scope==='repository')continue;
  if(command.scope==='conversation'){
   const record=await owned('conversation',target);if(record.kind!=='conversation'||record.value.sourceId!==sourceId)throw Error('Conversation source differs.');
  }else{
   const record=await owned('message',target);if(record.kind!=='message')throw Error('Message identity differs.');
   const conversation=await owned('conversation',record.value.conversationId);if(conversation.kind!=='conversation'||conversation.value.sourceId!==sourceId)throw Error('Message source differs.');
  }
 }
 if(command.scope==='repository')await resolveRepositories(ctx,pairs,retain,owned);
 const revision=(previousRow?.row_revision??0)+1;if(!Number.isSafeInteger(revision))throw Error('Association rule revision exceeded.');
 const provenanceRef=`owner-mutation:${ctx.mutationId}`,value=AssociationRuleSchema.parse({id:logical,projectId:project.id,areaId:command.areaId,scope:command.scope,targetIds,reason:command.reason,provenanceRef,rowRevision:revision});
 const destinations=[{projectId:project.id,areaId:command.areaId},...(previous?.kind==='association_rule'?[{projectId:previous.value.projectId,areaId:previous.value.areaId}]:[])];
 const affectedDestinations=[...new Map(destinations.map(destination=>[canonical(destination),destination])).values()];
 const record=parseHistoryRecord({id:physical,kind:'association_rule',value}),eventId=crypto.randomUUID();
 return {planningAfter:ctx.before.workspace,writes:[{table:'project_history',id:physical,operation:previousRow?'update':'insert',expectedRowRevision:previousRow?.row_revision??null,value:record as unknown as JsonValue}],preconditions:[...preconditions.values()],events:[{id:eventId,kind:command.type,entityType:'history-association',entityId:logical,changes:[{path:['project_history',physical],before:{exists:previous!==null,value:previous as unknown as JsonValue},after:{exists:true,value:record as unknown as JsonValue}}],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:provenanceRef,undoOf:null}],jobs:[{id:crypto.randomUUID(),kind:'area_analysis',dedupeKey:`association:${logical}:${revision}`,notBefore:ctx.now,payload:{ruleId:logical,ruleRevision:revision,projectId:project.id,areaId:command.areaId,sourceIds:[...new Set(pairs.map(([source])=>source))],affectedDestinations}}]};
}};
async function resolveRepositories(ctx:PrepareContext,pairs:readonly [string,string][],retain:(row:ModuleRow)=>void,owned:(kind:'source'|'conversation'|'message',id:string)=>Promise<HistoryRecord>){
 const pending=new Set(pairs.map(([source,repository])=>associationTarget(source,repository)));let after='',scanned=0;
 while(pending.size){
  const rows=await ctx.query.list('project_history',{after,limit:200});if(!rows.length)break;
  for(const row of rows){
   if(++scanned>10000)throw Error('Repository mapping exceeds the bounded retained-context scan. Narrow the source mapping.');
   const raw=JSON.parse(row.payload_json);if(raw.kind!=='conversation'&&raw.kind!=='claim')continue;
   const record=await decode(row);
   const context=record.kind==='conversation'?{sourceId:record.value.sourceId,conversationId:record.value.id,repositoryIdentity:record.value.repositoryIdentity}:record.kind==='claim'?record.value.context:null;
   if(!context?.repositoryIdentity||record.kind==='claim'&&record.value.context.basis==='owner_override')continue;
   const repository=canonicalRepositoryIdentity(context.repositoryIdentity);if(!repository)continue;
   const key=associationTarget(context.sourceId,repository);if(!pending.has(key))continue;
   const conversation=await owned('conversation',context.conversationId);if(conversation.kind!=='conversation'||conversation.value.sourceId!==context.sourceId)throw Error('Retained repository context source differs.');
   if(record.kind==='claim'){
    const message=await owned('message',record.value.context.messageRevisionId);if(message.kind!=='message'||message.value.conversationId!==context.conversationId)throw Error('Retained repository context message differs.');
   }
   retain(row);pending.delete(key);
  }
  after=rows.at(-1)!.id;
 }
 if(pending.size)throw Error('Repository mapping needs a matching retained source context; titles are not identity evidence.');
}
export const historyAssociationCommandHandlers=new Map([['history.association.set',historyAssociationCommandHandler]]);
