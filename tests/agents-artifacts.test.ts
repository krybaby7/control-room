import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {createR2BlobStore,prepareAttachmentReservation,stageAttachmentUpload,prepareAttachmentFinalization,readReadyAttachment,type AttachmentBucket} from '../lib/attachments.ts';
import {validateAgentResultArtifacts,artifactPhysicalMime,AgentArtifactValidationError,type AgentArtifactAccess,type AgentResultArtifactRef,type AttemptArtifactBinding} from '../lib/agents/artifacts.ts';
import type {ModuleRow} from '../lib/workspace-modules.ts';
const owner='synthetic-artifact-owner',attempt='synthetic-attempt',now='2026-10-18T12:00:00.000Z',namespace='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const stream=(value:Uint8Array)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(value.slice());controller.close();}});
async function fixture(){
 type ObjectValue={bytes:Uint8Array;httpMetadata:{contentType:string};customMetadata:{sha256:string}};
 const objects=new Map<string,ObjectValue>(),rows=new Map<string,ModuleRow>(),bindings=new Map<string,AttemptArtifactBinding>();
 const bucket:AttachmentBucket={
  async put(key,bytes,options){if(objects.has(key))return null;objects.set(key,{bytes:bytes.slice(),httpMetadata:{...options.httpMetadata},customMetadata:{...options.customMetadata}});return {size:bytes.byteLength};},
  async get(key){const value=objects.get(key);return value?{size:value.bytes.byteLength,body:stream(value.bytes),httpMetadata:{...value.httpMetadata},customMetadata:{...value.customMetadata}}:null;},
  async head(key){const value=objects.get(key);return value?{size:value.bytes.byteLength,httpMetadata:{...value.httpMetadata},customMetadata:{...value.customMetadata}}:null;},
  async delete(key){objects.delete(key);}
 },store=createR2BlobStore(bucket),bytes=new TextEncoder().encode('Synthetic private result bytes only.\n');
 const reservation=prepareAttachmentReservation(owner,{filename:'synthetic-report.md',mimeType:artifactPhysicalMime('text/markdown'),expectedBytes:bytes.byteLength,uploadMutationId:'synthetic-upload'},{bytes:0,files:0},{ownerNamespace:namespace,now,createId:()=>id});
 const staged=await stageAttachmentUpload(owner,reservation,stream(bytes),store,{ownerNamespace:namespace,now});assert.equal(staged.status,'staged');
 const record=await prepareAttachmentFinalization(owner,reservation,store,{ownerNamespace:namespace,now}),payload=canonical(record);
 rows.set(id,{id,row_revision:1,payload_json:payload,content_hash:await contentHash(payload)});bindings.set(id,{ownerId:owner,attemptId:attempt,artifactId:id,logicalType:'summary'});
 const ref:AgentResultArtifactRef={id,sha256:record.sha256!,bytes:bytes.byteLength,type:'summary'};
 let physicalReads=0;
 const access:AgentArtifactAccess={query:{async get(table,key){assert.equal(table,'attachments');return rows.get(key)??null;},async list(){throw new Error('No unbounded artifact enumeration allowed.');}},async readBinding(key){return bindings.get(key)??null;},async verifyPhysical(value){physicalReads++;const verified=await readReadyAttachment(owner,value,store,{ownerNamespace:namespace,now});return {record:value,verifiedBytes:verified.bytes.byteLength,verifiedSha256:verified.metadata.sha256,signatureVerified:true};}};
 return {objects,rows,bindings,bucket,store,record,bytes,ref,access,physicalReads:()=>physicalReads};
}
const input=(refs:AgentResultArtifactRef[])=>({ownerId:owner,attemptId:attempt,artifactRefs:refs,now});
test('real shared private R2 boundary verifies selected immutable bytes and returns only typed refs and CAS proof',async()=>{
 const f=await fixture(),result=await validateAgentResultArtifacts(input([f.ref]),f.access);
 assert.deepEqual(result.artifacts,[f.ref]);assert.equal(result.totalBytes,f.bytes.length);assert.equal(result.preconditions[0].expectedRowRevision,1);assert.equal(result.preconditions[0].expectedHash,f.rows.get(id)!.content_hash);assert.match(result.bindingHashes[0].hash,/^[a-f0-9]{64}$/);
 for(const secret of [owner,namespace,'attachments/','Synthetic private result bytes'])assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal(f.physicalReads(),1);assert.equal(artifactPhysicalMime('text/x-diff'),'text/plain');assert.equal(artifactPhysicalMime('application/json'),'application/json');assert.throws(()=>artifactPhysicalMime('text/html'),AgentArtifactValidationError);
});
test('wrong owner, attempt, binding type and missing owner record fail before any private bytes are read',async()=>{
 for(const patch of [{ownerId:'synthetic-foreign-owner'},{attemptId:'synthetic-foreign-attempt'},{logicalType:'patch' as const}]){
  const f=await fixture();f.bindings.set(id,{...f.bindings.get(id)!,...patch});await assert.rejects(validateAgentResultArtifacts(input([f.ref]),f.access),AgentArtifactValidationError);assert.equal(f.physicalReads(),0);
 }
 const missing=await fixture();missing.rows.clear();await assert.rejects(validateAgentResultArtifacts(input([missing.ref]),missing.access),AgentArtifactValidationError);assert.equal(missing.physicalReads(),0);
 const unbound=await fixture();unbound.bindings.clear();await assert.rejects(validateAgentResultArtifacts(input([unbound.ref]),unbound.access),AgentArtifactValidationError);
});
test('declared digest/length, unsafe type/name and metadata digest mismatches fail closed',async()=>{
 for(const patch of [{sha256:'a'.repeat(64)},{bytes:0}]){
  const f=await fixture();await assert.rejects(validateAgentResultArtifacts(input([{...f.ref,...patch}]),f.access),AgentArtifactValidationError);assert.equal(f.physicalReads(),0);
 }
 const unsafe=await fixture(),row=unsafe.rows.get(id)!;row.payload_json=canonical({...unsafe.record,filename:'../private.html',mimeType:'text/html'});row.content_hash=await contentHash(row.payload_json);await assert.rejects(validateAgentResultArtifacts(input([unsafe.ref]),unsafe.access),AgentArtifactValidationError);
 const corrupt=await fixture();corrupt.rows.get(id)!.content_hash='b'.repeat(64);await assert.rejects(validateAgentResultArtifacts(input([corrupt.ref]),corrupt.access),AgentArtifactValidationError);
});
test('missing object, corrupted private R2 bytes and absent binding cannot become verified artifacts',async()=>{
 const missing=await fixture();missing.objects.clear();await assert.rejects(validateAgentResultArtifacts(input([missing.ref]),missing.access),AgentArtifactValidationError);
 const corrupt=await fixture();corrupt.objects.get(corrupt.record.storageKey)!.bytes[0]^=1;await assert.rejects(validateAgentResultArtifacts(input([corrupt.ref]),corrupt.access),AgentArtifactValidationError);
 const unavailable=await fixture(),none=createR2BlobStore();unavailable.access.verifyPhysical=async record=>{await readReadyAttachment(owner,record,none,{ownerNamespace:namespace,now});return null;};await assert.rejects(validateAgentResultArtifacts(input([unavailable.ref]),unavailable.access),AgentArtifactValidationError);
 const falseProof=await fixture();falseProof.access.verifyPhysical=async record=>({record,verifiedBytes:falseProof.ref.bytes,verifiedSha256:falseProof.ref.sha256,signatureVerified:false});await assert.rejects(validateAgentResultArtifacts(input([falseProof.ref]),falseProof.access),AgentArtifactValidationError);
});
test('row and attempt binding changes during physical verification invalidate the whole package',async()=>{
 const rowRace=await fixture(),verifyRow=rowRace.access.verifyPhysical;rowRace.access.verifyPhysical=async record=>{const proof=await verifyRow(record);rowRace.rows.get(id)!.row_revision++;return proof;};await assert.rejects(validateAgentResultArtifacts(input([rowRace.ref]),rowRace.access),(error:unknown)=>error instanceof AgentArtifactValidationError&&error.code==='changed_during_verification');
 const bindingRace=await fixture(),verifyBinding=bindingRace.access.verifyPhysical;bindingRace.access.verifyPhysical=async record=>{const proof=await verifyBinding(record);bindingRace.bindings.set(id,{...bindingRace.bindings.get(id)!,attemptId:'other-attempt'});return proof;};await assert.rejects(validateAgentResultArtifacts(input([bindingRace.ref]),bindingRace.access),(error:unknown)=>error instanceof AgentArtifactValidationError&&error.code==='changed_during_verification');
});
test('duplicate IDs, two-MiB transcript and ten-MiB package caps reject before lookup without pruning any object',async()=>{
 const f=await fixture();await assert.rejects(validateAgentResultArtifacts(input([f.ref,f.ref]),f.access),AgentArtifactValidationError);
 await assert.rejects(validateAgentResultArtifacts(input([{...f.ref,type:'transcript',bytes:2097153}]),f.access),AgentArtifactValidationError);
 const refs=Array.from({length:11},(_,index)=>({...f.ref,id:'22222222-2222-4222-8222-'+String(index).padStart(12,'0'),bytes:1048576}));
 await assert.rejects(validateAgentResultArtifacts(input(refs),f.access),AgentArtifactValidationError);assert.equal(f.physicalReads(),0);assert.equal(f.objects.size,1);assert.equal(f.rows.size,1);
});

test('verification snapshots copied row metadata even when an injected reader reuses a mutable row object',async()=>{
 const f=await fixture(),original=f.rows.get(id)!,beforeRevision=original.row_revision,verify=f.access.verifyPhysical;
 f.access.verifyPhysical=async record=>{const proof=await verify(record);original.payload_json=canonical({...record,readyAt:'2026-10-18T11:59:59.000Z'});original.content_hash=await contentHash(original.payload_json);return proof;};
 await assert.rejects(validateAgentResultArtifacts(input([f.ref]),f.access),(error:unknown)=>error instanceof AgentArtifactValidationError&&error.code==='changed_during_verification');
 assert.equal(original.row_revision,beforeRevision,'payload/hash races are detected independently of row revision');
});
