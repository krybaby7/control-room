import {inspectAgentArtifactContent} from './artifact-content-policy.ts';
import {z} from 'zod';
import type {SqlDatabase} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import type {PrivateIngressVerifier} from '../devices/contracts.ts';
import {unavailablePrivateIngress} from '../devices/contracts.ts';
import {authenticateDevice} from '../devices/auth.ts';
import {issueMutationId,checkMutationEpoch,mutationEpoch,MutationEpochError} from '../idempotency-retention.ts';
import {executeWorkspaceCommand} from '../workspace-transaction.ts';
import {workspaceHandlers} from '../workspace-handlers.ts';
import {ownerAttachmentServices} from '../attachment-services.ts';
import {getWorkspaceNamespaces} from '../workspace-namespaces.ts';
import {beginUpload,finishUpload} from '../attachment-upload-fences.ts';
import {settleUploadBody} from '../upload-body-settlement.ts';
import {readAttachmentStream,validateAttachmentContent,AttachmentPolicyError} from '../attachment-policy.ts';
import {createR2BlobStore,stageAttachmentUpload,attachmentHash,AttachmentReplayMismatchError,type AttachmentBucket} from '../attachments.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {agentIdSchema,agentDigestSchema} from './contracts.ts';
import {agentArtifactTypeSchema} from './artifacts.ts';
import {agentArtifactCommandHandlers,agentArtifactReserveValueSchema,validateAgentArtifactMetadata,normalizeAgentArtifactMime} from './artifact-handlers.ts';
import {authorizeAgentArtifactAttempt,assertAgentArtifactReservationCapacity,readOwnedAgentArtifact,AgentArtifactStoreError,type AgentArtifactMaterial} from './artifact-store.ts';
import {RecoverabilityCapacityError} from '../recoverability-admission.ts';
import {RetiredMutationError,MutationIdReuseError,ModuleConflictError,CommandValidationError} from '../workspace-errors.ts';
export type AgentArtifactHttpAction='mutation-id'|'reserve'|'finalize'|'content';
export interface AgentArtifactHttpDependencies {db:SqlDatabase|null;bucket?:AttachmentBucket;ingress?:PrivateIngressVerifier;now?:()=>string}
export const agentArtifactHttpHeaders={'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff'};
const lease=z.object({attemptId:agentIdSchema,leaseToken:z.string().regex(/^[a-f0-9]{64}$/u)}).strict(),mutationId=z.string().regex(/^m1_[a-f0-9]{32}_[a-f0-9]{32}$/u),revision=z.number().int().positive().safe();
const reserve=lease.extend({revision,mutationId,filename:agentArtifactReserveValueSchema.shape.filename,mimeType:agentArtifactReserveValueSchema.shape.mimeType,expectedBytes:agentArtifactReserveValueSchema.shape.expectedBytes,logicalType:agentArtifactTypeSchema,sha256:agentDigestSchema}).strict(),finalize=lease.extend({revision,mutationId,id:z.string().uuid()}).strict();
function response(body:unknown,status=200){return Response.json(body,{status,headers:agentArtifactHttpHeaders});}
function rejected(status:number,code='agent_artifact_rejected'){return response({error:'Private agent artifact request was rejected.',code},status);}
async function json(request:Request):Promise<unknown>{
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new AgentArtifactStoreError('json_required',415);
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d{1,12}$/u.test(length)||Number(length)>65536))throw new AgentArtifactStoreError('body_bound',413);
 const reader=request.body?.getReader();if(!reader)throw new AgentArtifactStoreError('body_required',400);const chunks:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined;
 const read=async()=>{for(;;){const part=await reader.read();if(part.done)break;if(!(part.value instanceof Uint8Array))throw new AgentArtifactStoreError('body_invalid',400);size+=part.value.byteLength;if(size>65536)throw new AgentArtifactStoreError('body_bound',413);chunks.push(part.value.slice());}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new AgentArtifactStoreError('body_invalid',400);}};
 try{return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AgentArtifactStoreError('body_deadline',408)),15000);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* bounded stream cancellation */}}
}
async function activeMutation(db:SqlDatabase,owner:string,id:string){if(mutationEpoch(id)===null||(await checkMutationEpoch(db,owner,id)).status!=='active')throw new AgentArtifactStoreError('active_mutation_required',409);}
function publicArtifact(value:Awaited<ReturnType<typeof readOwnedAgentArtifact>>){return {id:value.attachment.id,status:value.attachment.status,filename:value.attachment.filename,mimeType:value.attachment.mimeType,expectedBytes:value.material.bytes,declaredSha256:value.material.sha256,logicalType:value.material.logicalType};}
/** Fixed private device routes. No browser identity, provider proof or caller SQL
 * callback can authorize a reservation, object write or finalization. */
export async function handleAgentArtifactHttp(action:AgentArtifactHttpAction,request:Request,deps:AgentArtifactHttpDependencies,artifactId?:string):Promise<Response>{
 try{
  if(!['mutation-id','reserve','finalize','content'].includes(action))return rejected(400);const method=action==='content'?'PUT':'POST';if(request.method!==method)return new Response(null,{status:405,headers:{...agentArtifactHttpHeaders,Allow:method}});
  if(request.headers.has('Cookie'))return rejected(403);if(new URL(request.url).search)return rejected(400);if(!deps.db)return rejected(503,'agent_artifact_unavailable');const db=deps.db,clock=deps.now??(()=>new Date().toISOString()),before=evidenceDateSchema.parse(clock());
  const principal=await authenticateDevice(request,'jobs:poll',db,deps.ingress??unavailablePrivateIngress,before);if(!principal)return rejected(401,'agent_unauthorized');if(!principal.scopes.includes('jobs:report'))return rejected(403,'agent_scope_mismatch');
  const path=action==='content'?'/api/bridge/jobs/artifacts/'+encodeURIComponent(z.string().uuid().parse(artifactId))+'/content':'/api/bridge/jobs/artifacts/'+action;if(new URL(request.url).pathname!==path)return rejected(404);
  if(action==='content'){
   const credentials=lease.parse({attemptId:request.headers.get('x-control-room-attempt'),leaseToken:request.headers.get('x-control-room-lease')}),id=z.string().uuid().parse(artifactId),first=await readOwnedAgentArtifact(db,principal,credentials,id,before);
   if(first.attachment.status!=='reserved')return rejected(409);if(!request.body||normalizeAgentArtifactMime(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()??'')!==first.attachment.mimeType)return rejected(415);
   const length=request.headers.get('content-length');if(length!==null&&(!/^\d{1,12}$/u.test(length)||Number(length)!==first.material.bytes))return rejected(413);
   const store=createR2BlobStore(deps.bucket);if(!store.available)return rejected(503,'agent_artifact_storage_unavailable');
   const bytes=await readAttachmentStream(request.body,{maxBytes:first.material.bytes,deadlineMs:15000});validateAttachmentContent(bytes,first.attachment.mimeType,first.material.bytes);if(await attachmentHash(bytes)!==first.material.sha256)return rejected(422,'artifact_digest_differs');
   if(!inspectAgentArtifactContent(bytes).allowed)return rejected(422,'artifact_sensitive_content');
   const fresh=evidenceDateSchema.parse(clock());if(Date.parse(fresh)<Date.parse(before))return rejected(401);const current=await readOwnedAgentArtifact(db,principal,credentials,id,fresh);if(current.row.row_revision!==first.row.row_revision||current.row.content_hash!==first.row.content_hash||current.material.sha256!==first.material.sha256)return rejected(409);
   const namespaces=await getWorkspaceNamespaces(db,principal.ownerId);if(!namespaces)return rejected(503,'agent_artifact_storage_unavailable');
   const token=await beginUpload(db,principal.ownerId,{record:current.attachment,rowRevision:current.row.row_revision,ownerNamespace:namespaces.blobNamespace,now:fresh},current.material.guard);if(!token)return rejected(409);
   let writing=false,settled=false;const guarded={...store,async put(...args:Parameters<typeof store.put>){writing=true;const result=await store.put(...args);settled=true;return result;}};
   let staged;try{const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});staged=await stageAttachmentUpload(principal.ownerId,current.attachment,stream,guarded,{ownerNamespace:namespaces.blobNamespace,now:fresh});}finally{if(!writing||settled)await finishUpload(db,principal.ownerId,{token,now:evidenceDateSchema.parse(clock()),definitivelySettled:true});}
   if(staged.status!=='staged')return rejected(staged.status==='quarantined'?422:503,'artifact_stage_unconfirmed');
   if(staged.blob.sha256!==current.material.sha256||staged.blob.bytes!==current.material.bytes)return rejected(422,'artifact_digest_differs');return response({status:'staged',id,bytes:staged.blob.bytes,sha256:staged.blob.sha256,finalized:false});
  }
  const raw=await json(request),fresh=evidenceDateSchema.parse(clock());if(Date.parse(fresh)<Date.parse(before))return rejected(401);
  if(action==='mutation-id'){const input=lease.parse(raw),auth=await authorizeAgentArtifactAttempt(db,principal,input,fresh),id=await issueMutationId(db,principal.ownerId,fresh),current=await readCurrent(db,principal.ownerId,fresh);if(!await db.prepare('SELECT 1 WHERE '+auth.guard.sql).bind(...auth.guard.bindings).first())return rejected(409);return response({mutationId:id,revision:current.revision});}
  const input=action==='reserve'?reserve.parse(raw):finalize.parse(raw),credentials={attemptId:input.attemptId,leaseToken:input.leaseToken};await activeMutation(db,principal.ownerId,input.mutationId);
  let material:AgentArtifactMaterial,command:unknown;
  if(action==='reserve'){
   const selected=reserve.parse(input),value=validateAgentArtifactMetadata({filename:selected.filename,mimeType:selected.mimeType,expectedBytes:selected.expectedBytes},selected.logicalType),auth=await authorizeAgentArtifactAttempt(db,principal,credentials,fresh);await assertAgentArtifactReservationCapacity(db,principal.ownerId,auth.attemptId,selected.expectedBytes,selected.mutationId);material={attemptId:auth.attemptId,logicalType:selected.logicalType,sha256:selected.sha256,bytes:selected.expectedBytes,guard:auth.guard};command={type:'jobs.artifact.reserve',value:{filename:selected.filename,mimeType:selected.mimeType,expectedBytes:value.expectedBytes},logicalType:selected.logicalType,sha256:selected.sha256};
  }else{const selected=finalize.parse(input),owned=await readOwnedAgentArtifact(db,principal,credentials,selected.id,fresh);material=owned.material;command={type:'jobs.artifact.finalize',id:selected.id};}
  const access=await ownerAttachmentServices(db,principal.ownerId,fresh,deps.bucket),result=await executeWorkspaceCommand(principal.ownerId,{protocolVersion:1,expectedRevision:input.revision,mutationId:input.mutationId,command},{db,now:()=>fresh,handlers:new Map([...workspaceHandlers,...agentArtifactCommandHandlers]),...access,agentArtifact:material});
  if(result.status==='conflict')return response({status:'conflict',currentRevision:result.currentRevision},409);
  let id:string;if(action==='finalize')id=finalize.parse(input).id;else{const rows=(await db.prepare("SELECT a.id FROM attachments a JOIN agent_artifacts b ON b.user_id=a.user_id AND b.artifact_id=a.id WHERE a.user_id=? AND b.attempt_id=? AND json_extract(a.payload_json,'$.uploadMutationId')=? LIMIT 2").bind(principal.ownerId,input.attemptId,input.mutationId).all<{id:string}>()).results;if(rows.length!==1)throw new AgentArtifactStoreError('artifact_commit_unconfirmed',503);id=rows[0].id;}
  const owned=await readOwnedAgentArtifact(db,principal,credentials,id,evidenceDateSchema.parse(clock()));return response({status:result.status,receipt:result.receipt,currentRevision:result.envelope.revision,artifact:publicArtifact(owned)});
 }catch(error){
  if(error instanceof MutationEpochError)return rejected(400,'active_mutation_required');
  if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof CommandValidationError)return rejected(400);
  if(error instanceof RecoverabilityCapacityError||error instanceof RetiredMutationError||error instanceof MutationIdReuseError||error instanceof ModuleConflictError||error instanceof AttachmentReplayMismatchError)return rejected(409);
  if(error instanceof AttachmentPolicyError)return rejected(error.code==='file_too_large'||error.code==='length_mismatch'?413:error.code==='upload_timeout'?408:422);
  if(error instanceof AgentArtifactStoreError)return rejected(error.status,error.code);return rejected(503,'agent_artifact_unavailable');
 }finally{await settleUploadBody(request.body);}
}
