import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactFixture,artifactNow,artifactLater} from './fixtures/agent-artifact.ts';
import {handleAgentArtifactHttp} from '../lib/agents/artifact-http.ts';
import {attachmentHash,createR2BlobStore,readReadyAttachment} from '../lib/attachments.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import type {SqlDatabase,SqlStatement} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {readCurrent} from '../lib/workspace-store.ts';
import {workspaceAdmission} from '../lib/workspace-admission.ts';
import {canonical} from '../lib/canonical-json.ts';
import {retireEpoch,mutationEpoch} from '../lib/idempotency-retention.ts';
type Fixture=Awaited<ReturnType<typeof artifactFixture>>;
const deps=(f:Fixture)=>({db:f.db,bucket:f.bucket,ingress:f.ingress,now:()=>artifactNow});
const lease=(f:Fixture)=>({attemptId:f.lease.attemptId,leaseToken:f.lease.leaseToken});
const request=(f:Fixture,action:string,value:unknown,headers:Record<string,string>={})=>new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+action,{method:'POST',headers:{'content-type':'application/json','x-control-room-device':f.deviceSecret,...headers},body:JSON.stringify(value)});
async function identity(f:Fixture){const response=await handleAgentArtifactHttp('mutation-id',request(f,'mutation-id',lease(f)),deps(f));assert.equal(response.status,200);return await response.json() as {mutationId:string;revision:number};}
async function reserve(f:Fixture,bytes:Uint8Array,patch:Record<string,unknown>={}){const issued=await identity(f),value={...lease(f),...issued,filename:'synthetic-result.txt',mimeType:'text/plain',expectedBytes:bytes.length,logicalType:'summary',sha256:await attachmentHash(bytes),...patch},response=await handleAgentArtifactHttp('reserve',request(f,'reserve',value),deps(f));return {value,response};}
function upload(f:Fixture,id:string,bytes:Uint8Array){return new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+id+'/content',{method:'PUT',headers:{'x-control-room-device':f.deviceSecret,'x-control-room-attempt':f.lease.attemptId,'x-control-room-lease':f.lease.leaseToken,'content-type':'text/plain','content-length':String(bytes.length)},body:bytes as BodyInit});}
const count=(f:Fixture,table:string)=>Number((f.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get() as {n:number}).n);
test('actual SQLite private HTTP reserve/stage/finalize is receipted once and leaves planning/acceptance unchanged',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const before=(f.sqlite.prepare('SELECT content FROM workspaces WHERE user_id=?').get(f.owner) as {content:string}).content,bytes=new TextEncoder().encode('Synthetic artifact bytes; no actual runtime execution.\n'),reserved=await reserve(f,bytes);assert.equal(reserved.response.status,200);const first=await reserved.response.json() as {status:string;artifact:{id:string;status:string};receipt:{mutationId:string}};assert.equal(first.status,'committed');assert.equal(first.artifact.status,'reserved');assert.equal(first.receipt.mutationId,reserved.value.mutationId);
 const retry=await handleAgentArtifactHttp('reserve',request(f,'reserve',reserved.value),deps(f));assert.equal(retry.status,200);assert.equal((await retry.json() as {status:string}).status,'replayed');assert.equal(count(f,'agent_artifacts'),1);assert.equal(count(f,'attachments'),1);assert.equal(count(f,'audit_events'),1);
 const staged=await handleAgentArtifactHttp('content',upload(f,first.artifact.id,bytes),deps(f),first.artifact.id);assert.equal(staged.status,200);assert.equal((await staged.json() as {status:string;finalized:boolean}).status,'staged');assert.equal(JSON.parse((await ownerReader(f.db,f.owner).get('attachments',first.artifact.id))!.payload_json).status,'reserved');assert.equal(f.objects.size,1);
 const issued=await identity(f),finalValue={...lease(f),...issued,id:first.artifact.id},final=await handleAgentArtifactHttp('finalize',request(f,'finalize',finalValue),deps(f));assert.equal(final.status,200);assert.equal((await final.json() as {artifact:{status:string}}).artifact.status,'ready');const replay=await handleAgentArtifactHttp('finalize',request(f,'finalize',finalValue),deps(f));assert.equal(replay.status,200);assert.equal((await replay.json() as {status:string}).status,'replayed');
 const row=await ownerReader(f.db,f.owner).get('attachments',first.artifact.id),namespace=await getWorkspaceNamespaces(f.db,f.owner);assert.ok(row&&namespace);const verified=await readReadyAttachment(f.owner,JSON.parse(row.payload_json),createR2BlobStore(f.bucket),{ownerNamespace:namespace.blobNamespace,now:artifactNow});assert.deepEqual(verified.bytes,bytes);assert.equal(await ownerReader(f.db,'foreign-synthetic-owner').get('attachments',first.artifact.id),null);
 assert.equal((f.sqlite.prepare('SELECT content FROM workspaces WHERE user_id=?').get(f.owner) as {content:string}).content,before);assert.equal(count(f,'agent_results'),0);assert.equal((f.sqlite.prepare('SELECT status FROM agent_job_state WHERE user_id=? AND job_id=?').get(f.owner,f.jobId) as {status:string}).status,'leased');assert.equal(count(f,'audit_events'),2);const events=f.sqlite.prepare('SELECT origin,source_ref FROM audit_events ORDER BY ordinal').all() as Array<{origin:string;source_ref:string}>;assert.ok(events.every(event=>event.origin==='connector'&&event.source_ref===f.lease.attemptId));assert.equal(count(f,'attachment_upload_attempts'),1);assert.equal((f.sqlite.prepare('SELECT settled_at FROM attachment_upload_attempts').get() as {settled_at:string}).settled_at,artifactNow);
});
test('wrong original SHA is rejected before any R2 put or upload attempt and cannot poison the reservation',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const bytes=new TextEncoder().encode('Synthetic original bytes.\n'),reserved=await reserve(f,bytes);assert.equal(reserved.response.status,200);const id=(await reserved.response.json() as {artifact:{id:string}}).artifact.id,bad=bytes.slice();bad[0]^=1;const response=await handleAgentArtifactHttp('content',upload(f,id,bad),deps(f),id);assert.equal(response.status,422);assert.equal(f.objects.size,0);assert.equal(count(f,'attachment_upload_attempts'),0);assert.equal(JSON.parse((await ownerReader(f.db,f.owner).get('attachments',id))!.payload_json).status,'reserved');
 const good=await handleAgentArtifactHttp('content',upload(f,id,bytes),deps(f),id);assert.equal(good.status,200);assert.equal(f.objects.size,1);const settledRetry=await handleAgentArtifactHttp('content',upload(f,id,bytes),deps(f),id);assert.equal(settledRetry.status,200);assert.equal(count(f,'attachment_upload_attempts'),2);assert.equal(f.objects.size,1);
});
test('private ingress/device authorization precedes JSON/body operations; forged owners and legacy IDs do not write',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const value={...lease(f),revision:1,mutationId:'legacy_client_mutation_00000001',filename:'synthetic.txt',mimeType:'text/plain',expectedBytes:1,logicalType:'summary',sha256:'a'.repeat(64)};
 const unauth=await handleAgentArtifactHttp('reserve',request(f,'reserve',value),{...deps(f),ingress:undefined});assert.equal(unauth.status,401);const wrong=new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/reserve',{method:'POST',headers:{'content-type':'application/json','x-control-room-device':'wrong_synthetic_device_credential_0000000000'},body:'private invalid JSON'});assert.equal((await handleAgentArtifactHttp('reserve',wrong,deps(f))).status,401);assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',value,{'cookie':'session=forged'}),deps(f))).status,403);assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',value),deps(f))).status,400);
 const issued=await identity(f);assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',{...value,...issued,ownerId:'foreign'}),deps(f))).status,400);assert.equal(count(f,'attachments'),0);assert.equal(count(f,'agent_artifacts'),0);
});
test('unknown and retired m1 epochs, cancellation and transcript/package bounds fail before metadata growth',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const bytes=new TextEncoder().encode('x'),issued=await identity(f),base={...lease(f),...issued,filename:'synthetic.txt',mimeType:'text/plain',expectedBytes:1,logicalType:'summary',sha256:await attachmentHash(bytes)};
 assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',{...base,mutationId:'m1_'+'e'.repeat(32)+'_'+'d'.repeat(32)}),deps(f))).status,400);await retireEpoch(f.db,f.owner,mutationEpoch(issued.mutationId)!,artifactNow);assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',base),deps(f))).status,409);
 const next=await identity(f);assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',{...base,...next,logicalType:'transcript',expectedBytes:2*1024*1024+1}),deps(f))).status,400);assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',{...base,...next,expectedBytes:10*1024*1024+1}),deps(f))).status,400);f.sqlite.prepare('UPDATE agent_job_state SET cancel_requested_at=? WHERE user_id=? AND job_id=?').run(artifactNow,f.owner,f.jobId);assert.equal((await handleAgentArtifactHttp('reserve',request(f,'reserve',{...base,...next}),deps(f))).status,409);assert.equal(count(f,'attachments'),0);assert.equal(count(f,'agent_artifacts'),0);
});

test('late cancellation at the actual upload-attempt INSERT is fenced before any object put',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const bytes=new TextEncoder().encode('Synthetic late-race bytes.\n'),reserved=await reserve(f,bytes);assert.equal(reserved.response.status,200);const id=(await reserved.response.json() as {artifact:{id:string}}).artifact.id;
 const racing:SqlDatabase={prepare(sql){const original=f.db.prepare(sql);if(!sql.includes('INSERT INTO attachment_upload_attempts'))return original;const statement:SqlStatement={bind(...values){original.bind(...values);return this;},first<T>(){return original.first<T>();},all<T>(){return original.all<T>();},async run(){f.sqlite.prepare('UPDATE agent_job_state SET cancel_requested_at=? WHERE user_id=? AND job_id=?').run(artifactNow,f.owner,f.jobId);return original.run();}};return statement;},batch(statements){return f.db.batch(statements);}};
 const response=await handleAgentArtifactHttp('content',upload(f,id,bytes),{...deps(f),db:racing},id);assert.equal(response.status,409);assert.equal(f.objects.size,0);assert.equal(count(f,'attachment_upload_attempts'),0);
});
test('ambiguous PUT keeps its nonexpiring pending fence and never invents finalized availability',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const bytes=new TextEncoder().encode('Synthetic uncertain write.\n'),reserved=await reserve(f,bytes);assert.equal(reserved.response.status,200);let puts=0;const id=(await reserved.response.json() as {artifact:{id:string}}).artifact.id,bucket={...f.bucket,async put(...args:Parameters<typeof f.bucket.put>){puts++;await f.bucket.put(...args);throw new Error('Synthetic lost storage acknowledgement.');}};
 const response=await handleAgentArtifactHttp('content',upload(f,id,bytes),{...deps(f),bucket},id);assert.equal(response.status,503);assert.equal(f.objects.size,1);const pending=f.sqlite.prepare('SELECT token FROM attachment_upload_attempts').get() as {token:string};const retry=await handleAgentArtifactHttp('content',upload(f,id,bytes),{...deps(f),bucket},id);assert.equal(retry.status,409);assert.equal(puts,1);assert.equal(count(f,'attachment_upload_attempts'),1);assert.equal((f.sqlite.prepare('SELECT token FROM attachment_upload_attempts').get() as {token:string}).token,pending.token);assert.equal((f.sqlite.prepare('SELECT settled_at FROM attachment_upload_attempts').get() as {settled_at:null}).settled_at,null);assert.equal(JSON.parse((await ownerReader(f.db,f.owner).get('attachments',id))!.payload_json).status,'reserved');
});

test('known full attempt quota rejects growth while the original receipted reservation still replays',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const bytes=new TextEncoder().encode('one'),first=await reserve(f,bytes);assert.equal(first.response.status,200);const large=await reserve(f,bytes,{filename:'synthetic-large.txt',expectedBytes:10*1024*1024-bytes.length,sha256:'a'.repeat(64)});assert.equal(large.response.status,200);const overflow=await reserve(f,bytes,{filename:'synthetic-overflow.txt',expectedBytes:1,sha256:'b'.repeat(64)});assert.equal(overflow.response.status,409);const replay=await handleAgentArtifactHttp('reserve',request(f,'reserve',first.value),deps(f));assert.equal(replay.status,200);assert.equal((await replay.json() as {status:string}).status,'replayed');assert.equal(count(f,'agent_artifacts'),2);assert.equal(count(f,'attachments'),2);assert.equal(f.objects.size,0);
});

test('actual owner queue rechecks artifact lease deadline credential and private ingress before any receipted effect',async()=>{
 for(const defect of ['lease','deadline','credential','ingress','epoch'] as const){
  const f=await artifactFixture();let release!:()=>void,entered!:()=>void;
  const settling:Promise<unknown>[]=[];
  const released=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let currentNow=artifactNow,ingressAvailable=true;
  try{
   const issued=await identity(f),bytes=new TextEncoder().encode('Synthetic queued artifact.'),value={...lease(f),...issued,filename:'queued-report.txt',mimeType:'text/plain',expectedBytes:bytes.length,logicalType:'summary',sha256:await attachmentHash(bytes)};
   if(defect==='lease')f.sqlite.prepare('UPDATE job_attempts SET lease_expires_at=? WHERE user_id=?').run(artifactLater(1),f.owner);
   if(defect==='deadline')f.sqlite.prepare('UPDATE job_attempts SET deadline_at=? WHERE user_id=?').run(artifactLater(1),f.owner);
   if(defect==='credential')f.sqlite.prepare('UPDATE device_credentials SET expires_at=? WHERE user_id=?').run(artifactLater(1),f.owner);
   const snapshot=()=>canonical(Object.fromEntries(['attachments','attachment_usage','attachment_blob_objects','agent_artifacts','audit_events','workspace_mutations','workspaces'].map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=? ORDER BY rowid').all(f.owner)]))),before=snapshot(),current=await readCurrent(f.db,f.owner,artifactNow);
   // A real public shared-executor invocation owns the same owner ticket and
   // later fails validation, so it does not advance the editor revision.
   const blocker=executeWorkspaceCommand(f.owner,{protocolVersion:1,expectedRevision:current.revision,mutationId:'synthetic-queue-block-'+crypto.randomUUID(),command:{type:'synthetic.queue.reject'}},{db:f.db,now:()=>currentNow,handlers:new Map([['synthetic.queue.reject',{async prepare(){entered();await released;throw new Error('Synthetic queued predecessor rejected.');}}]])});
   const rejectedBlocker=assert.rejects(blocker,/Synthetic queued predecessor rejected/);settling.push(rejectedBlocker);await started;
   const pending=handleAgentArtifactHttp('reserve',request(f,'reserve',value),{...deps(f),now:()=>currentNow,ingress:{async verify(){return ingressAvailable?{serviceIdentity:'synthetic-private-artifact-ingress'}:null;}}});
   settling.push(pending);const waitUntil=Date.now()+2000;while(workspaceAdmission.snapshot().waiting===0&&Date.now()<waitUntil)await new Promise(resolve=>setTimeout(resolve,1));
   assert.equal(workspaceAdmission.snapshot().waiting,1,'the actual artifact command must be queued before the clock changes');
   currentNow=artifactLater(2);if(defect==='ingress')ingressAvailable=false;if(defect==='epoch')f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=epoch+1 WHERE user_id=?').run(f.owner);release();
   const response=await pending;await rejectedBlocker;assert.equal(response.status,defect==='lease'||defect==='deadline'?409:401,defect);
   assert.equal(snapshot(),before,defect+' must not create metadata, bindings, ledger, audit or receipt');assert.equal(f.objects.size,0);
   assert.equal((await readCurrent(f.db,f.owner,currentNow)).revision,current.revision);
   const body=await response.text();assert.equal(body.includes(f.deviceSecret),false);assert.equal(body.includes(f.lease.leaseToken),false);
  }finally{release?.();await Promise.allSettled(settling);f.sqlite.close();}
 }
});
