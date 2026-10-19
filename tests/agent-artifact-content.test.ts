import {validateAgentArtifactMetadata} from '../lib/agents/artifact-handlers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectAgentArtifactContent} from '../lib/agents/artifact-content-policy.ts';
import {artifactFixture,artifactNow} from './fixtures/agent-artifact.ts';
import {handleAgentArtifactHttp} from '../lib/agents/artifact-http.ts';
import {attachmentHash} from '../lib/attachments.ts';
const encode=(value:string)=>new TextEncoder().encode(value);
test('bounded server heuristic detects named credentials without returning matched private content',()=>{
 const samples=['-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----','Authorization: Bearer '+'a'.repeat(40),'sk-proj-'+'b'.repeat(35),'ghp_'+'c'.repeat(36),'github_pat_'+'d'.repeat(40),'AKIA'+'A'.repeat(16),'{"leaseToken":"'+ 'e'.repeat(64)+'"}','deviceCredential='+ 'f'.repeat(40)];
 for(const sample of samples){const result=inspectAgentArtifactContent(encode(sample));assert.equal(result.allowed,false);assert.ok(result.codes.length);assert.ok(!JSON.stringify(result).includes(sample));}
 assert.deepEqual(inspectAgentArtifactContent(encode('Arabic نص and literal <script>data only</script>; no runtime proof.')),{allowed:true,codes:[]});
 assert.throws(()=>inspectAgentArtifactContent(new Uint8Array(10*1024*1024+1)));
 assert.throws(()=>inspectAgentArtifactContent(new Uint8Array([0xff])));
});
test('sensitive exact-digest artifact is rejected before upload token or R2 storage; never labelled quarantined/ready',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const deps={db:f.db,bucket:f.bucket,ingress:f.ingress,now:()=>artifactNow},lease={attemptId:f.lease.attemptId,leaseToken:f.lease.leaseToken},headers={'content-type':'application/json','x-control-room-device':f.deviceSecret};
 const post=(action:string,value:unknown)=>new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+action,{method:'POST',headers,body:JSON.stringify(value)});
 const issued=await handleAgentArtifactHttp('mutation-id',post('mutation-id',lease),deps);assert.equal(issued.status,200);const identity=await issued.json() as {revision:number;mutationId:string},bytes=encode('Synthetic fixture authorization: Bearer '+'x'.repeat(40));
 const reserved=await handleAgentArtifactHttp('reserve',post('reserve',{...lease,...identity,filename:'synthetic-sensitive.txt',mimeType:'text/plain',expectedBytes:bytes.length,logicalType:'transcript',sha256:await attachmentHash(bytes)}),deps);assert.equal(reserved.status,200);const id=(await reserved.json() as {artifact:{id:string}}).artifact.id;
 const put=new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+id+'/content',{method:'PUT',headers:{'content-type':'text/plain','x-control-room-device':f.deviceSecret,'x-control-room-attempt':lease.attemptId,'x-control-room-lease':lease.leaseToken},body:bytes as BodyInit});
 const response=await handleAgentArtifactHttp('content',put,deps,id);assert.equal(response.status,422);const result=await response.json() as {code:string};assert.equal(result.code,'artifact_sensitive_content');assert.equal(f.objects.size,0);assert.equal((f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts').get() as {n:number}).n,0);
 assert.equal(JSON.parse((f.sqlite.prepare('SELECT payload_json FROM attachments WHERE id=?').get(id) as {payload_json:string}).payload_json).status,'reserved');
 assert.equal((f.sqlite.prepare('SELECT COUNT(*) n FROM agent_results').get() as {n:number}).n,0);
});

test('all four declared formats preserve bytes while markdown/diff metadata becomes safe plain text; exact size edges remain closed',()=>{
 for(const value of [
  {mimeType:'text/plain' as const,filename:'report.txt',logicalType:'summary' as const,stored:'report.txt'},
  {mimeType:'text/markdown' as const,filename:'report.md',logicalType:'summary' as const,stored:'report.md'},
  {mimeType:'text/x-diff' as const,filename:'change.diff',logicalType:'patch' as const,stored:'change.diff.txt'},
  {mimeType:'application/json' as const,filename:'report.json',logicalType:'summary' as const,stored:'report.json'},
 ]){
  const metadata=validateAgentArtifactMetadata({filename:value.filename,mimeType:value.mimeType,expectedBytes:10*1024*1024},value.logicalType);assert.equal(metadata.filename,value.stored);assert.equal(metadata.mimeType,value.mimeType==='application/json'?'application/json':'text/plain');
  assert.equal(inspectAgentArtifactContent(encode('Synthetic harmless bytes')).allowed,true);
 }
 assert.equal(validateAgentArtifactMetadata({filename:'transcript.log',mimeType:'text/plain',expectedBytes:2*1024*1024},'transcript').expectedBytes,2*1024*1024);
 assert.throws(()=>validateAgentArtifactMetadata({filename:'transcript.log',mimeType:'text/plain',expectedBytes:2*1024*1024+1},'transcript'));
 assert.throws(()=>validateAgentArtifactMetadata({filename:'report.md',mimeType:'text/markdown',expectedBytes:10*1024*1024+1},'summary'));
 assert.throws(()=>validateAgentArtifactMetadata({filename:'bad.html',mimeType:'text/markdown',expectedBytes:1},'summary'));
 assert.throws(()=>validateAgentArtifactMetadata({filename:'bad.exe',mimeType:'text/x-diff',expectedBytes:1},'patch'));
 assert.throws(()=>validateAgentArtifactMetadata({filename:'../bad.diff',mimeType:'text/x-diff',expectedBytes:1},'patch'));
});

test('actual HTTP four-format stages retain exact bytes and raw declared metadata in mutation identity',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const deps={db:f.db,bucket:f.bucket,ingress:f.ingress,now:()=>artifactNow},lease={attemptId:f.lease.attemptId,leaseToken:f.lease.leaseToken};
 const post=(action:string,value:unknown)=>new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+action,{method:'POST',headers:{'content-type':'application/json','x-control-room-device':f.deviceSecret},body:JSON.stringify(value)});
 for(const format of [
  {mime:'text/plain',filename:'report.txt',logicalType:'summary',body:'Synthetic report.'},
  {mime:'text/markdown',filename:'report.md',logicalType:'summary',body:'# Synthetic report'},
  {mime:'text/x-diff',filename:'change.patch',logicalType:'patch',body:'diff --git a/synthetic b/synthetic\n'},
  {mime:'application/json',filename:'report.json',logicalType:'summary',body:'{"synthetic":true}'},
 ]){
  const issued=await handleAgentArtifactHttp('mutation-id',post('mutation-id',lease),deps);assert.equal(issued.status,200);const identity=await issued.json() as {revision:number;mutationId:string},bytes=encode(format.body),value={...lease,...identity,filename:format.filename,mimeType:format.mime,expectedBytes:bytes.length,logicalType:format.logicalType,sha256:await attachmentHash(bytes)};
  const reserved=await handleAgentArtifactHttp('reserve',post('reserve',value),deps);assert.equal(reserved.status,200);const row=(await reserved.json() as {artifact:{id:string;mimeType:string;filename:string}}).artifact;assert.equal(row.mimeType,format.mime==='application/json'?'application/json':'text/plain');assert.equal(row.filename,format.mime==='text/x-diff'?format.filename+'.txt':format.filename);
  if(format.mime==='text/markdown'){const changed=await handleAgentArtifactHttp('reserve',post('reserve',{...value,mimeType:'text/plain'}),deps);assert.equal(changed.status,409);}
  const put=new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+row.id+'/content',{method:'PUT',headers:{'content-type':format.mime,'x-control-room-device':f.deviceSecret,'x-control-room-attempt':lease.attemptId,'x-control-room-lease':lease.leaseToken},body:bytes as BodyInit});
  const staged=await handleAgentArtifactHttp('content',put,deps,row.id);assert.equal(staged.status,200);assert.equal((await staged.json() as {sha256:string}).sha256,value.sha256);
 }
 assert.equal(f.objects.size,4);assert.equal((f.sqlite.prepare('SELECT COUNT(*) n FROM agent_results').get() as {n:number}).n,0);
});
