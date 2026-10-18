import {z} from 'zod';
import type {AttachmentRecord} from './evidence-contract.ts';
import type {CommandHandler,MutationPlan,PrepareContext} from './workspace-transaction.ts';
import type {ModuleRow,GuardedWrite,RegisteredOwnerTable} from './workspace-modules.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {attachmentRecordSchema,attachmentUsageSchema} from './evidence-module.ts';
import {readReferenceSnapshot,referenceRegistry,type ReferenceSnapshot} from './workspace-references.ts';
import {prepareAttachmentReservation,prepareAttachmentFinalization,prepareAttachmentRetirement} from './attachments.ts';
import {ATTACHMENT_POLICY} from './attachment-policy.ts';
const id=z.string().min(1).max(128).refine(value=>value.trim()===value);
const commands=z.discriminatedUnion('type',[
 z.object({type:z.literal('attachment.reserve'),value:z.object({filename:z.string(),mimeType:z.string(),expectedBytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes)}).strict()}).strict(),
 z.object({type:z.literal('attachment.finalize'),id}).strict(),
 z.object({type:z.literal('attachment.retire'),id,reason:z.enum(['owner-delete','expired-reservation'])}).strict(),
]);
const json=(value:unknown)=>value as JsonValue;
async function all(ctx:PrepareContext,table:RegisteredOwnerTable):Promise<ModuleRow[]>{const result:ModuleRow[]=[];let after='';for(;;){const page=await ctx.query.list(table,{after,limit:200});for(const row of page){if(row.id<=after||result.length>=10000)throw new Error('Attachment module read limit/order differs.');after=row.id;result.push(row);}if(page.length<200)return result;}}
async function quota(ctx:PrepareContext){
 const snapshot=await readReferenceSnapshot(ctx.query,referenceRegistry),rows=await all(ctx,'attachments');
 const records=rows.map(row=>{const record=attachmentRecordSchema.parse(JSON.parse(row.payload_json));if(record.id!==row.id)throw new Error('Attachment row identity differs.');return {row,record};});
 const charged=records.filter(item=>item.record.status!=='deleted');const usage={bytes:charged.reduce((sum,item)=>sum+item.record.expectedBytes,0),files:charged.length};attachmentUsageSchema.parse(usage);
 const ledgers=await all(ctx,'attachment_usage');if(ledgers.length>1||ledgers.some(row=>row.id!=='quota'))throw new Error('Attachment quota ledger identity differs.');
 const ledger=ledgers[0]??null;if(ledger){const value=attachmentUsageSchema.parse(JSON.parse(ledger.payload_json));if(value.bytes!==usage.bytes||value.files!==usage.files)throw new Error('Attachment quota ledger differs from charged metadata.');}
 return {snapshot,records,usage,ledger};
}
function write(table:'attachments'|'attachment_usage',id:string,value:unknown,row:ModuleRow|null):GuardedWrite{return {table,id,value:json(value),operation:row?'update':'insert',expectedRowRevision:row?.row_revision??null};}
function plan(ctx:PrepareContext,snapshot:ReferenceSnapshot,before:AttachmentRecord|null,after:AttachmentRecord,usageBefore:{bytes:number;files:number},usageAfter:{bytes:number;files:number},row:ModuleRow|null,ledger:ModuleRow|null):MutationPlan{return {
 planningAfter:ctx.before.workspace,referenceSnapshot:snapshot,writes:[write('attachments',after.id,after,row),write('attachment_usage','quota',usageAfter,ledger)],jobs:[],events:[{id:crypto.randomUUID(),kind:ctx.command.type,entityType:'attachment',entityId:after.id,changes:[{path:['attachments',after.id],before:{exists:before!==null,value:json(before)},after:{exists:true,value:json(after)}},{path:['attachment_usage','quota'],before:{exists:ledger!==null,value:ledger?json(usageBefore):null},after:{exists:true,value:json(usageAfter)}}],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:null,undoOf:null}],
};}
function access(ctx:PrepareContext){if(!ctx.attachmentAccess?.store.available)throw new Error('Private attachment storage is unavailable. No reservation or finalization was saved.');return ctx.attachmentAccess;}
function backupReferences(bundle:Awaited<ReturnType<NonNullable<PrepareContext['backups']>['get']>>,attachmentId:string):boolean{
 if(!bundle)throw new Error('Retained backup could not be verified.');
 if(bundle.bundle.attachments.some(row=>row.id===attachmentId))return true;
 for(const raw of bundle.bundle.modules.attachments?.records??[]){const row=raw as {id?:unknown;value?:unknown};if(row.id===attachmentId)return true;const value=row.value as {kind?:unknown;physicalId?:unknown}|undefined;if(value?.kind==='legacy')throw new Error('Retained legacy attachment metadata needs explicit review.');}
 for(const raw of bundle.bundle.modules.evidence?.records??[]){const value=(raw as {value?:{kind?:unknown;record?:unknown}}).value;if(value?.kind==='version'){const record=value.record as {attachmentIds?:unknown};if(!Array.isArray(record?.attachmentIds))throw new Error('Retained evidence attachment references are invalid.');if(record.attachmentIds.includes(attachmentId))return true;}else if(value?.kind==='legacy')throw new Error('Retained legacy evidence needs explicit attachment reference review.');}
 return false;
}
const handler:CommandHandler={async prepare(ctx){
 const command=commands.parse(ctx.command);
 if(command.type==='attachment.retire'&&!ctx.attachmentAccess)throw new Error('The owner attachment namespace is unavailable.');
 const store=command.type==='attachment.retire'?ctx.attachmentAccess!:access(ctx);
 const data=await quota(ctx);
 if(command.type==='attachment.reserve'){
  const mutationId=ctx.mutationId;if(!mutationId||!/^[A-Za-z0-9_-]{16,128}$/.test(mutationId))throw new Error('A server mutation identity is required for the upload reservation.');
  const record=prepareAttachmentReservation(ctx.userId,{...command.value,uploadMutationId:mutationId},data.usage,{ownerNamespace:store!.ownerNamespace,now:ctx.now});
  if(data.records.some(item=>item.record.uploadMutationId===mutationId))throw new Error('This upload mutation identity is already reserved.');
  return plan(ctx,data.snapshot,null,record,data.usage,{bytes:data.usage.bytes+record.expectedBytes,files:data.usage.files+1},null,data.ledger);
 }
 const selected=data.records.find(item=>item.record.id===command.id);if(!selected)throw new Error('Attachment is missing or unavailable for this owner.');
 if(command.type==='attachment.finalize'){
  const record=await prepareAttachmentFinalization(ctx.userId,selected.record,store!.store,{ownerNamespace:store!.ownerNamespace,now:ctx.now});
  return plan(ctx,data.snapshot,selected.record,record,data.usage,data.usage,selected.row,data.ledger);
 }
 const refs=data.snapshot.rows.flatMap(row=>row.references.filter(ref=>ref.kind==='attachment'&&ref.id===command.id).map(()=>`${row.module}:${row.id}`));
 if(!ctx.backups)throw new Error('Retained backup references are unavailable.');
 for(const backup of await ctx.backups.list())if(backup.status==='ready'&&backupReferences(await ctx.backups.get(backup.id),command.id))refs.push(`backup:${backup.id}`);
 if(refs.length)throw new Error('Attachment is still referenced by immutable evidence, acceptance or a retained backup.');
 // Retirement itself performs no object I/O. The later cleanup job must recheck namespace and references.
 const ownerNamespace=ctx.attachmentAccess!.ownerNamespace;
 const retired=prepareAttachmentRetirement(ctx.userId,selected.record,refs,{ownerNamespace,now:ctx.now},command.reason);
 const output=plan(ctx,data.snapshot,selected.record,retired.record,data.usage,{bytes:data.usage.bytes-selected.record.expectedBytes,files:data.usage.files-1},selected.row,data.ledger);
 output.jobs.push({id:crypto.randomUUID(),kind:'attachment.cleanup',dedupeKey:`retire:${command.id}`,payload:json(retired.cleanup),notBefore:ctx.now});return output;
}};
export const attachmentCommandHandlers:ReadonlyMap<string,CommandHandler>=new Map(['attachment.reserve','attachment.finalize','attachment.retire'].map(type=>[type,handler]));
