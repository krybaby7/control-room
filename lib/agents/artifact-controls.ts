import {z} from 'zod';
import {prepareAttachmentReservation} from '../attachments.ts';
import {getWorkspaceNamespaces} from '../workspace-namespaces.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {ownerReader} from '../workspace-modules.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {attachmentRecordSchema,attachmentUsageSchema} from '../evidence-module.ts';
import {agentArtifactCommandSchema,validateAgentArtifactMetadata} from './artifact-handlers.ts';
import type {AgentArtifactMaterial} from './artifact-store.ts';
import type {MutationPlan} from '../workspace-transaction.ts';
import type {WorkspaceCommand} from '../workspace-protocol.ts';
import type {Workspace} from '../types.ts';
import {CommandValidationError} from '../workspace-errors.ts';
const materialSchema=z.object({attemptId:z.string().min(1).max(128),logicalType:z.enum(['summary','patch','transcript','diagnostic']),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative().max(10485760),guard:z.object({sql:z.string().min(1).max(1800000),bindings:z.array(z.union([z.string(),z.number().finite(),z.null()])).max(10000)}).strict()}).strict();
function fail():never{throw new CommandValidationError('Agent artifact requires an exact scoped lease and metadata-only proposal.');}
export async function validateAgentArtifactPlan(db:SqlDatabase,owner:string,command:WorkspaceCommand,plan:MutationPlan,before:Workspace,material:AgentArtifactMaterial|undefined,now:string,mutationId:string):Promise<{record:ReturnType<typeof attachmentRecordSchema.parse>;material:AgentArtifactMaterial}|null>{
 const selected=command.type==='jobs.artifact.reserve'||command.type==='jobs.artifact.finalize';
 if(!selected){if(material)fail();return null;}
 const parsed=materialSchema.safeParse(material),input=agentArtifactCommandSchema.safeParse(command);if(!parsed.success||!input.success)fail();const proof=parsed.data;
 if(proof.logicalType==='transcript'&&proof.bytes>2097152)fail();
 const allowed=new Set(['planningAfter','writes','referenceSnapshot','preconditions','jobs','events']);
 if(Object.keys(plan).some(key=>!allowed.has(key))||canonical(plan.planningAfter)!==canonical(before)||plan.jobs.length||!plan.referenceSnapshot||plan.writes.length!==2||plan.events.length!==1)fail();
 const row=plan.writes.find(write=>write.table==='attachments'),quota=plan.writes.find(write=>write.table==='attachment_usage'&&write.id==='quota');if(!row||!quota||row.operation==='delete'||quota.operation==='delete')fail();
 const record=attachmentRecordSchema.parse(row.value);attachmentUsageSchema.parse(quota.value);
 if(record.id!==row.id||record.expectedBytes!==proof.bytes||!['text/plain','application/json'].includes(record.mimeType)||plan.events[0].origin!=='connector'||plan.events[0].actorId!==owner||plan.events[0].sourceRef!==proof.attemptId||plan.events[0].entityId!==record.id||plan.events[0].kind!==command.type||plan.events[0].entityType!=='attachment'||plan.events[0].undoOf!==null)fail();
 const reader=ownerReader(db,owner),existing:ReturnType<typeof attachmentRecordSchema.parse>[]=[];let after='';
 for(;;){
  const page=await reader.list('attachments',{after,limit:200});
  for(const stored of page){if(stored.id<=after||existing.length>=500)fail();after=stored.id;const value=attachmentRecordSchema.parse(JSON.parse(stored.payload_json));if(value.id!==stored.id||await contentHash(canonical(value))!==stored.content_hash)fail();
   const quote=plan.referenceSnapshot.rows.find(row=>row.module==='attachments'&&row.id===stored.id);if(!quote||quote.rowRevision!==stored.row_revision||quote.contentHash!==stored.content_hash)fail();existing.push(value);
  }if(page.length<200)break;
 }
 if(plan.referenceSnapshot.rows.filter(row=>row.module==='attachments').length!==existing.length)fail();
 const charged=existing.filter(value=>value.status!=='deleted'),beforeQuota={bytes:charged.reduce((sum,value)=>sum+value.expectedBytes,0),files:charged.length},afterQuota=input.data.type==='jobs.artifact.reserve'?{bytes:beforeQuota.bytes+proof.bytes,files:beforeQuota.files+1}:beforeQuota;
 if(canonical(quota.value)!==canonical(afterQuota))fail();
 if(input.data.type==='jobs.artifact.finalize'){
  const original=existing.find(value=>value.id===record.id);if(!original||original.status!=='reserved'||canonical(record)!==canonical({...original,status:'ready',actualBytes:proof.bytes,sha256:proof.sha256,readyAt:now}))fail();
 }else if(existing.some(value=>value.id===record.id)||record.createdAt!==now||record.uploadMutationId!==mutationId)fail();
 if(input.data.type==='jobs.artifact.reserve'){
  const namespaces=await getWorkspaceNamespaces(db,owner);if(!namespaces)fail();
  const normalized=validateAgentArtifactMetadata(input.data.value,input.data.logicalType);
  const exact=prepareAttachmentReservation(owner,{...normalized,uploadMutationId:mutationId},beforeQuota,{ownerNamespace:namespaces.blobNamespace,now,createId:()=>record.id});if(canonical(exact)!==canonical(record))fail();
  if(input.data.logicalType!==proof.logicalType||input.data.sha256!==proof.sha256||input.data.value.expectedBytes!==proof.bytes||record.filename!==normalized.filename||record.mimeType!==normalized.mimeType||row.operation!=='insert'||row.expectedRowRevision!==null||record.status!=='reserved'||record.sha256!==null||record.actualBytes!==null||record.readyAt!==null)fail();
 }else if(row.operation!=='update'||input.data.id!==row.id||record.status!=='ready'||record.actualBytes!==proof.bytes||record.sha256!==proof.sha256||record.readyAt===null)fail();
 return {record,material:proof};
}
