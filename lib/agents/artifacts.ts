import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {validateAttachmentMetadata} from '../attachment-policy.ts';
import type {AttachmentRecord} from '../evidence-contract.ts';
import type {VerifiedAttachment} from '../evidence-requirements.ts';
import type {OwnerScopedReader,RowPrecondition} from '../workspace-modules.ts';
import {AGENT_LIMITS,agentIdSchema,agentDigestSchema} from './contracts.ts';
export const AGENT_ARTIFACT_LIMITS=Object.freeze({count:100,transcriptBytes:AGENT_LIMITS.outputBytes,packageBytes:AGENT_LIMITS.resultBytes,verificationMs:15000});
export const agentArtifactTypeSchema=z.enum(['summary','patch','transcript','diagnostic']);
export type AgentArtifactType=z.infer<typeof agentArtifactTypeSchema>;
export const agentResultArtifactRefSchema=z.object({id:z.string().uuid(),sha256:agentDigestSchema,bytes:z.number().int().nonnegative().safe().max(AGENT_LIMITS.resultBytes),type:agentArtifactTypeSchema}).strict().refine(value=>value.type!=='transcript'||value.bytes<=AGENT_LIMITS.outputBytes,'Raw transcripts are limited to two MiB.');
export type AgentResultArtifactRef=z.infer<typeof agentResultArtifactRefSchema>;
export const attemptArtifactBindingSchema=z.object({ownerId:z.string().min(1).max(256),attemptId:agentIdSchema,artifactId:z.string().uuid(),logicalType:agentArtifactTypeSchema}).strict();
export type AttemptArtifactBinding=z.infer<typeof attemptArtifactBindingSchema>;
const recordSchema=z.object({id:z.string().uuid(),status:z.enum(['reserved','ready','quarantined','deleted']),filename:z.string().min(1).max(240),mimeType:z.string().min(1).max(128),expectedBytes:z.number().int().nonnegative().safe(),actualBytes:z.number().int().nonnegative().safe().nullable(),sha256:agentDigestSchema.nullable(),storageKey:z.string().min(1).max(512),createdAt:evidenceDateSchema,expiresAt:evidenceDateSchema,readyAt:evidenceDateSchema.nullable(),uploadMutationId:z.string().min(1).max(160),quarantineReason:z.string().max(200).nullable()}).strict();
export type AgentArtifactFailure='invalid_reference'|'binding_unavailable'|'owner_mismatch'|'attempt_mismatch'|'type_mismatch'|'attachment_unavailable'|'attachment_integrity'|'physical_unavailable'|'changed_during_verification';
export class AgentArtifactValidationError extends Error{
 readonly code:AgentArtifactFailure;
 constructor(code:AgentArtifactFailure){super('Private result artifact validation failed.');this.name='AgentArtifactValidationError';this.code=code;}
}
/** Logical markdown/diff bytes use the existing private text/plain boundary.
 * This does not expand the global attachment MIME allowlist or render HTML.
 */
export function artifactPhysicalMime(logicalMimeType:unknown):'text/plain'|'application/json'{
 if(logicalMimeType==='application/json')return 'application/json';
 if(typeof logicalMimeType==='string'&&['text/plain','text/markdown','text/x-diff'].includes(logicalMimeType))return 'text/plain';
 throw new AgentArtifactValidationError('type_mismatch');
}
export interface AgentArtifactAccess {
 query:OwnerScopedReader;
 /** Server-owned lookup of the private attempt binding. Never accept this from
  * browser JSON or treat a caller-supplied owner/attempt as authorization. */
 readBinding:(artifactId:string)=>Promise<AttemptArtifactBinding|null>;
 /** Existing owner-bound private ledger/R2 verifier must reject purged/fenced
  * objects and verify actual bytes, digest, MIME and signature. No new bucket,
  * storage key, public URL, credential, or upload grant is created here. */
 verifyPhysical:(record:AttachmentRecord)=>Promise<VerifiedAttachment|null>;
}
export interface VerifiedAgentArtifactPackage {
 artifacts:AgentResultArtifactRef[];
 totalBytes:number;
 preconditions:RowPrecondition[];
 bindingHashes:Array<{artifactId:string;hash:string}>;
}
function fail(code:AgentArtifactFailure):never{throw new AgentArtifactValidationError(code);}
function typeMatches(type:AgentArtifactType,record:AttachmentRecord):boolean{
 if(!['text/plain','application/json'].includes(record.mimeType))return false;
 const extension=record.filename.slice(record.filename.lastIndexOf('.')+1).toLowerCase();
 if(type==='patch')return record.mimeType==='text/plain'&&extension==='txt';
 if(type==='transcript')return record.mimeType==='text/plain'&&['txt','log'].includes(extension);
 return record.mimeType==='application/json'?extension==='json':['txt','md','log'].includes(extension);
}
async function boundRead<T>(work:()=>Promise<T>,expires:number):Promise<T>{
 const remaining=expires-Date.now();if(remaining<=0)fail('physical_unavailable');let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([Promise.resolve().then(work),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AgentArtifactValidationError('physical_unavailable')),remaining);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
/** Read-only package proposal. The caller must atomically assert these exact row
 * preconditions plus owner/attempt/binding and physical-ledger authority when
 * committing a result. This helper does not finalize, accept, run, or delete.
 */
export async function validateAgentResultArtifacts(input:{ownerId:string;attemptId:string;artifactRefs:readonly AgentResultArtifactRef[];now:string},access:AgentArtifactAccess):Promise<VerifiedAgentArtifactPackage>{
 const owner=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).parse(input.ownerId),attempt=agentIdSchema.parse(input.attemptId),now=evidenceDateSchema.parse(input.now);
 let refs:AgentResultArtifactRef[];try{refs=z.array(agentResultArtifactRefSchema).max(AGENT_ARTIFACT_LIMITS.count).parse(input.artifactRefs);}catch{fail('invalid_reference');}
 if(new Set(refs.map(ref=>ref.id)).size!==refs.length||refs.reduce((sum,ref)=>sum+ref.bytes,0)>AGENT_ARTIFACT_LIMITS.packageBytes)fail('invalid_reference');
 const expires=Date.now()+AGENT_ARTIFACT_LIMITS.verificationMs,result:VerifiedAgentArtifactPackage={artifacts:[],totalBytes:0,preconditions:[],bindingHashes:[]};
 for(const ref of refs){
  const rawBinding=await boundRead(()=>access.readBinding(ref.id),expires);if(!rawBinding)fail('binding_unavailable');
  let binding:AttemptArtifactBinding;try{binding=attemptArtifactBindingSchema.parse(rawBinding);}catch{fail('binding_unavailable');}if(binding.ownerId!==owner)fail('owner_mismatch');if(binding.attemptId!==attempt||binding.artifactId!==ref.id)fail('attempt_mismatch');if(binding.logicalType!==ref.type)fail('type_mismatch');
  const fetched=await boundRead(()=>access.query.get('attachments',ref.id),expires),row=fetched?{...fetched}:null;if(!row||row.id!==ref.id||!Number.isSafeInteger(row.row_revision)||row.row_revision<1)fail('attachment_unavailable');
  let record:AttachmentRecord;try{record=recordSchema.parse(JSON.parse(row.payload_json));validateAttachmentMetadata(record);}catch{fail('attachment_integrity');}
  if(await contentHash(canonical(record))!==row.content_hash||record.id!==ref.id||record.status!=='ready'||record.actualBytes!==ref.bytes||record.expectedBytes!==ref.bytes||record.sha256!==ref.sha256||record.readyAt===null||Date.parse(record.readyAt)>Date.parse(now)||Date.parse(record.createdAt)>Date.parse(now))fail('attachment_integrity');
  if(!typeMatches(ref.type,record))fail('type_mismatch');
  let physical:VerifiedAttachment|null;try{physical=await boundRead(()=>access.verifyPhysical(structuredClone(record)),expires);}catch{fail('physical_unavailable');}
  if(!physical||physical.signatureVerified!==true||physical.verifiedSha256!==ref.sha256||physical.verifiedBytes!==ref.bytes||canonical(physical.record)!==canonical(record))fail('physical_unavailable');
  const after=await boundRead(()=>access.query.get('attachments',ref.id),expires),afterBinding=await boundRead(()=>access.readBinding(ref.id),expires);
  if(!after||after.row_revision!==row.row_revision||after.content_hash!==row.content_hash||after.payload_json!==row.payload_json||canonical(afterBinding)!==canonical(binding))fail('changed_during_verification');
  result.artifacts.push(structuredClone(ref));result.totalBytes+=ref.bytes;result.preconditions.push({table:'attachments',id:ref.id,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});result.bindingHashes.push({artifactId:ref.id,hash:await contentHash(canonical(binding))});
 }
 return result;
}
