import {z} from 'zod';
import type {SqlDatabase} from '../workspace-store.ts';
import type {AgentStoreOptions} from './store.ts';
import {readOwnedAgentResultArtifact,type OwnedAgentArtifact} from './artifact-store.ts';
import {validateAgentResultArtifacts} from './artifacts.ts';
import {agentDigestSchema,agentAliasSchema,agentCommitSchema} from './contracts.ts';
import {ownerReader,type ModuleRow} from '../workspace-modules.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {getWorkspaceNamespaces} from '../workspace-namespaces.ts';
import {createR2BlobStore,readReadyAttachment,type AttachmentBucket} from '../attachments.ts';
import {attachmentRecordSchema} from '../evidence-module.ts';
import type {AttachmentRecord} from '../evidence-contract.ts';
import type {DeviceSqlGuard} from '../devices/auth.ts';
const text=z.string().max(8192).refine(value=>!value.includes('\0'));
const path=z.string().min(1).max(1000).refine(value=>!value.startsWith('/')&&!/[\\:*?"<>|%\[\]{}\u0000-\u001f\u007f]/u.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&part.toLowerCase()!=='.git'&&!/[. ]$/u.test(part)&&!/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?$/iu.test(part)));
/** These source hashes/lines and findings remain device claims. This schema
 * verifies byte format, never source-file existence, execution or finding truth. */
export const agentInspectionResultSchema=z.object({summary:text.refine(value=>!!value.trim()),findings:z.array(z.object({path,line:z.number().int().min(1).max(1000000),claim:text,evidenceSha256:agentDigestSchema}).strict()).max(100),limitations:z.array(text).max(100)}).strict();
const uniquePaths=(values:string[])=>new Set(values.map(value=>value.toLowerCase())).size===values.length;
export const agentPatchScopeSchema=z.object({format:z.literal('agent-patch-scope'),schemaVersion:z.literal(1),repositoryKey:agentAliasSchema,baseCommit:agentCommitSchema,allowedPaths:z.array(path).min(1).max(100).refine(uniquePaths),protectedPaths:z.array(path).max(100).refine(uniquePaths)}).strict();
export class AgentResultVerificationError extends Error {readonly code='approved_patch_scope_required';readonly status=409;constructor(){super('Approved frozen patch scope is required.');this.name='AgentResultVerificationError';}}
function rejected():never{throw new Error('Private result bytes or format could not be verified.');}
/** Physical immutable bytes + closed operation format only. Model/process proof
 * remains the terminal event store's responsibility; owner acceptance is separate. */
export function createAgentResultVerifier({db,bucket,now=()=>new Date().toISOString()}:{db:SqlDatabase;bucket?:AttachmentBucket;now?:()=>string}):NonNullable<AgentStoreOptions['verifyResult']>{
 const verify:NonNullable<AgentStoreOptions['verifyResult']>=async input=>{
  if(input.result.disposition==='succeeded'&&(input.result.artifactIds.length!==1))rejected();
  if(!input.result.artifactIds.length)return {adapterChecksPassed:false};
  if(!bucket||input.result.artifactIds.length>100)rejected();
  const at=now(),expires=Date.now()+15000,owner=input.principal.ownerId,namespaces=await getWorkspaceNamespaces(db,owner);if(!namespaces)rejected();
  const scopeRows:Array<{row:ModuleRow;attachment:AttachmentRecord}>=[];const selected=new Map<string,OwnedAgentArtifact>(),bytesById=new Map<string,Uint8Array>(),store=createR2BlobStore(bucket);
  for(const id of input.result.artifactIds){const owned=await readOwnedAgentResultArtifact(db,input.principal,{attemptId:input.attemptId,record:input.record,binding:input.executionBinding,epoch:input.result.epoch},id,at);selected.set(id,owned);}
  const verified=await validateAgentResultArtifacts({ownerId:owner,attemptId:input.attemptId,artifactRefs:[...selected].map(([id,v])=>({id,sha256:v.material.sha256,bytes:v.material.bytes,type:v.material.logicalType})),now:at},{query:ownerReader(db,owner),readBinding:async id=>{const v=selected.get(id);if(!v)return null;const current=await readOwnedAgentResultArtifact(db,input.principal,{attemptId:input.attemptId,record:input.record,binding:input.executionBinding,epoch:input.result.epoch},id,at);if(canonical(current.material)!==canonical(v.material))rejected();return {ownerId:owner,attemptId:input.attemptId,artifactId:id,logicalType:current.material.logicalType};},verifyPhysical:async record=>{
   if(Date.now()>=expires)rejected();const selectedArtifact=selected.get(record.id);if(!selectedArtifact)rejected();
   const guard=physicalGuard(owner,namespaces.blobNamespace,selectedArtifact);if(!await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first())rejected();
   const physical=await readReadyAttachment(owner,record,store,{ownerNamespace:namespaces.blobNamespace,now:at,deadlineMs:Math.max(1,expires-Date.now())});bytesById.set(record.id,physical.bytes);
   return {record,verifiedSha256:physical.metadata.sha256,verifiedBytes:physical.bytes.length,signatureVerified:true};
  }});
  if(verified.totalBytes>input.record.spec.outputBytesLimit)rejected();
  if(input.result.disposition==='succeeded'){
   const artifact=selected.values().next().value!,bytes=bytesById.get(artifact.attachment.id);if(!bytes)rejected();
   if(input.record.spec.operation==='project.inspect'){if(artifact.material.logicalType!=='summary'||artifact.attachment.mimeType!=='application/json')rejected();agentInspectionResultSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
   else{
    if(artifact.material.logicalType!=='patch'||artifact.attachment.mimeType!=='text/plain')rejected();
    const refs=input.executionBinding.artifactRefs;if(refs.length>8||refs.reduce((n,r)=>n+r.bytes,0)>32768)rejected();const scopes:z.infer<typeof agentPatchScopeSchema>[]=[];
    for(const ref of refs){const row=await ownerReader(db,owner).get('attachments',ref.id);if(!row)rejected();const record=attachmentRecordSchema.parse(JSON.parse(row.payload_json));if(record.id!==ref.id||record.status!=='ready'||record.expectedBytes!==ref.bytes||record.actualBytes!==ref.bytes||record.sha256!==ref.sha256||await contentHash(canonical(record))!==row.content_hash)rejected();if(record.mimeType!=='application/json')continue;
     const g=physicalGuard(owner,namespaces.blobNamespace,{attachment:record});if(!await db.prepare('SELECT 1 WHERE '+g.sql).bind(...g.bindings).first())rejected();
     const proof=await readReadyAttachment(owner,record,store,{ownerNamespace:namespaces.blobNamespace,now:at,deadlineMs:Math.max(1,expires-Date.now())});const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(proof.bytes)) as {format?:unknown};if(raw?.format!=='agent-patch-scope')continue;
     const scope=agentPatchScopeSchema.parse(raw);if(scope.repositoryKey!==input.record.spec.repositoryKey||scope.baseCommit!==input.record.spec.baseCommit||await contentHash(canonical(scope.allowedPaths))!==input.executionBinding.allowedPathsSha256)rejected();scopes.push(scope);scopeRows.push({row,attachment:record});
    }
    if(scopes.length!==1)throw new AgentResultVerificationError();validateAgentPatchFormat(bytes,scopes[0]);
   }
  }
  const guard=packageGuard(owner,namespaces.blobNamespace,input.attemptId,[...selected.values()],scopeRows);
  if(Date.now()>=expires||!await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first())rejected();
  return {adapterChecksPassed:input.result.disposition==='succeeded',guard};
 };
 return async input=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([verify(input),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Private result verification timed out.')),15000);})]);}finally{if(timer!==undefined)clearTimeout(timer);}};
}
function physicalGuard(owner:string,namespace:string,value:{attachment:AttachmentRecord}):DeviceSqlGuard{
 const a=value.attachment;return {sql:'EXISTS(SELECT 1 FROM workspace_source_namespaces n WHERE n.user_id=? AND n.blob_namespace=?) AND EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.storage_key=? AND o.attachment_id=? AND o.namespace=? AND o.bytes=? AND o.sha256=? AND o.verified_at IS NOT NULL AND o.purged_at IS NULL) AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences f WHERE f.user_id=? AND (f.storage_key=? OR f.attachment_id=?)) AND NOT EXISTS(SELECT 1 FROM attachment_upload_attempts u WHERE u.user_id=? AND u.settled_at IS NULL AND (u.storage_key=? OR u.attachment_id=?)) AND NOT EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims c WHERE c.user_id=? AND c.storage_key=?)',bindings:[owner,namespace,owner,a.storageKey,a.id,namespace,a.actualBytes,a.sha256,owner,a.storageKey,a.id,owner,a.storageKey,a.id,owner,a.storageKey]};
}

function packageGuard(owner:string,namespace:string,attemptId:string,selected:OwnedAgentArtifact[],scopeRows:Array<{row:ModuleRow;attachment:AttachmentRecord}>):DeviceSqlGuard{
 const snapshots=[];
 for(const v of selected)snapshots.push({row:v.row,binding:v.bindingSnapshot,key:v.attachment.storageKey,bytes:v.material.bytes,sha256:v.material.sha256});
 for(const v of scopeRows)snapshots.push({row:v.row,binding:null,key:v.attachment.storageKey,bytes:v.attachment.actualBytes,sha256:v.attachment.sha256});
 const auth=selected[0].authorization.guard;
 const sql=`(${auth.sql}) AND NOT EXISTS(SELECT 1 FROM json_each(?) snap WHERE NOT EXISTS(SELECT 1 FROM attachments a WHERE a.user_id=? AND a.id=json_extract(snap.value,'$.row.id') AND a.row_revision=json_extract(snap.value,'$.row.row_revision') AND a.content_hash=json_extract(snap.value,'$.row.content_hash') AND a.payload_json=json_extract(snap.value,'$.row.payload_json')) OR (json_extract(snap.value,'$.binding') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_artifacts b WHERE b.user_id=? AND b.attempt_id=? AND b.artifact_id=json_extract(snap.value,'$.binding.artifact_id') AND b.logical_type=json_extract(snap.value,'$.binding.logical_type') AND b.bytes=json_extract(snap.value,'$.binding.bytes') AND b.sha256=json_extract(snap.value,'$.binding.sha256') AND b.created_at=json_extract(snap.value,'$.binding.created_at'))) OR NOT EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.namespace=? AND o.storage_key=json_extract(snap.value,'$.key') AND o.attachment_id=json_extract(snap.value,'$.row.id') AND o.bytes=json_extract(snap.value,'$.bytes') AND o.sha256=json_extract(snap.value,'$.sha256') AND o.verified_at IS NOT NULL AND o.purged_at IS NULL) OR EXISTS(SELECT 1 FROM attachment_blob_fences f WHERE f.user_id=? AND (f.storage_key=json_extract(snap.value,'$.key') OR f.attachment_id=json_extract(snap.value,'$.row.id'))) OR EXISTS(SELECT 1 FROM attachment_upload_attempts u WHERE u.user_id=? AND u.settled_at IS NULL AND (u.storage_key=json_extract(snap.value,'$.key') OR u.attachment_id=json_extract(snap.value,'$.row.id'))) OR EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims c WHERE c.user_id=? AND c.storage_key=json_extract(snap.value,'$.key'))) AND EXISTS(SELECT 1 FROM workspace_source_namespaces n WHERE n.user_id=? AND n.blob_namespace=?)`;
 return {sql,bindings:[...auth.bindings,canonical(snapshots),owner,owner,attemptId,owner,namespace,owner,owner,owner,owner,namespace]};
}
/** Format/scope only; local git apply --check still proves applicability. */
export function validateAgentPatchFormat(bytes:Uint8Array,scope:z.infer<typeof agentPatchScopeSchema>):void{
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>2097152)rejected();const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!value||!value.endsWith('\n')||/[\0\r]/u.test(value))rejected();
 const lines=value.slice(0,-1).split('\n'),seen=new Set<string>();let i=0;
 const inside=(candidate:string,base:string)=>candidate===base||candidate.startsWith(base+'/');
 while(i<lines.length){
  const header=/^diff --git a\/([^\s"]+) b\/([^\s"]+)$/u.exec(lines[i++]);if(!header||header[1]!==header[2])rejected();const selected=path.parse(header[1]),lower=selected.toLowerCase();
  if(seen.has(lower)||seen.size>=100||selected.split('/').some(p=>['.gitattributes','.gitmodules'].includes(p.toLowerCase()))||!scope.allowedPaths.some(p=>inside(lower,p.toLowerCase()))||scope.protectedPaths.some(p=>inside(lower,p.toLowerCase())))rejected();seen.add(lower);
  if(lines[i++]!=='--- a/'+selected||lines[i++]!=='+++ b/'+selected)rejected();let hunks=0;
  while(i<lines.length&&!lines[i].startsWith('diff --git ')){
   const hunk=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: [^\u0000-\u001f]*)?$/u.exec(lines[i++]);if(!hunk)rejected();
   let old=Number(hunk[2]??1),next=Number(hunk[4]??1);if([hunk[1],hunk[2]??'1',hunk[3],hunk[4]??'1'].some(n=>!Number.isSafeInteger(Number(n))||Number(n)>1000000))rejected();let body=false;
   while(old>0||next>0){const line=lines[i++];if(typeof line!=='string')rejected();if(line[0]===' '){old--;next--;}else if(line[0]==='-')old--;else if(line[0]==='+')next--;else rejected();if(old<0||next<0)rejected();body=true;if(lines[i]==='\\ No newline at end of file')i++;}
   if(!body)rejected();hunks++;
  }
  if(!hunks)rejected();
 }
 if(!seen.size)rejected();
}
