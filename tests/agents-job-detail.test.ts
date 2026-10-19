import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {readAgentJobDetail,readAgentJobEvents} from '../lib/agents/detail-store.ts';
import {handleOwnerJobRead} from '../lib/agents/owner-read-http.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {attachmentStorageKey} from '../lib/attachments.ts';
import {jobArtifactDisplaySchema,jobEventPageSchema} from '../lib/agents/detail-contracts.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-detail-owner',attemptId='synthetic-detail-attempt',sha='a'.repeat(64);
async function fixture(){
 const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);
 const current=await readCurrent(f.db,owner,now),task=current.workspace.tasks.find(row=>row.status!=='archived')!;
 await executeWorkspaceCommand(owner,{protocolVersion:1,mutationId:crypto.randomUUID(),expectedRevision:current.revision,command:{type:'jobs.create',value:{operation:'project.inspect',projectId:task.projectId,taskId:task.id,repositoryKey:'control-room',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'gpt-6.1-sol',effort:'high',timeoutSeconds:60,outputBytesLimit:4096,dependsOnJobIds:[]}}},{db:f.db,handlers:workspaceHandlers,now:()=>now});
 const record=JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM agent_jobs WHERE user_id=?').get(owner)!.payload_json));
 // Synthetic private attempt metadata only; no provider or actual process is run.
 f.sqlite.prepare('INSERT INTO job_attempts(user_id,id,job_id,device_id,approval_id,execution_epoch,journal_nonce_hash,lease_token_hash,lease_expires_at,deadline_at,created_at,last_applied_sequence,operational_revision,identity_json) VALUES(?,?,?,?,?,0,?,?,?,?,?,60,1,?)').run(owner,attemptId,record.id,'synthetic-device','synthetic-approval',sha,sha,'2026-10-18T12:01:00.000Z','2026-10-18T12:02:00.000Z',now,canonical({record}));
 f.sqlite.prepare("UPDATE agent_job_state SET status='running',attempt_id=? WHERE user_id=? AND job_id=?").run(attemptId,owner,record.id);
 for(let sequence=1;sequence<=60;sequence++){
  const event={schemaVersion:1,attemptId,epoch:0,sequence,observedAt:now,diagnostic:'ok',kind:'progress',details:{stage:'executing',completedUnits:sequence,totalUnits:60}},hash=await contentHash(canonical(event));
  f.sqlite.prepare('INSERT INTO job_events(user_id,attempt_id,epoch,sequence,payload_hash,payload_json,receipt_json,received_at,applied_at) VALUES(?,?,0,?,?,?,?,?,?)').run(owner,attemptId,sequence,hash,canonical(event),'{}',now,now);
 }
 return {...f,record};
}
test('actual SQLite owner event pagination preserves exact frozen identity and returns no lease/credential authority',async()=>{
 const f=await fixture();try{
  const first=await readAgentJobEvents(f.db,owner,f.record.id,attemptId,now);assert.ok(first);assert.equal(first.items.length,50);assert.equal(first.nextAfterSequence,50);assert.equal(first.specSha256,f.record.specSha256);
  const second=await readAgentJobEvents(f.db,owner,f.record.id,attemptId,now,50);assert.ok(second);assert.equal(second.items.length,10);assert.equal(second.items[0].event.sequence,51);assert.equal(second.nextAfterSequence,null);
  const serialized=JSON.stringify(first);for(const key of ['lease_token_hash','journal_nonce_hash','identity_json','approval_id','receipt_json'])assert.equal(serialized.includes(key),false);
  assert.equal(await readAgentJobEvents(f.db,'foreign-owner',f.record.id,attemptId,now),null);
  assert.equal(await readAgentJobEvents(f.db,owner,'foreign-job',attemptId,now),null);
  const detail=await readAgentJobDetail(f.db,owner,f.record.id,now);assert.ok(detail);assert.equal(detail.job.record.id,f.record.id);assert.equal(detail.events!.items.length,50);assert.deepEqual(detail.artifacts,[]);
 }finally{f.sqlite.close();}
});
test('tampered event bodies and late attempt changes fail closed instead of presenting trusted provenance',async()=>{
 const f=await fixture();try{
  f.sqlite.prepare("UPDATE job_events SET payload_hash=? WHERE user_id=? AND sequence=1").run('b'.repeat(64),owner);
  await assert.rejects(readAgentJobEvents(f.db,owner,f.record.id,attemptId,now),/digest/);
  const response=await handleOwnerJobRead(new Request('https://example.test/api/jobs/'+f.record.id+'/events?attemptId='+attemptId),owner,f.db,f.record.id,now,true);assert.equal(response.status,503);assert.equal((await response.text()).includes('payload_hash'),false);
 }finally{f.sqlite.close();}
});
test('owner HTTP rejects foreign identities, unauthenticated reads and forged or duplicate cursors',async()=>{
 const f=await fixture();try{
  const base='https://example.test/api/jobs/'+f.record.id;
  assert.equal((await handleOwnerJobRead(new Request(base),null,f.db,f.record.id,now)).status,401);
  assert.equal((await handleOwnerJobRead(new Request(base),'foreign-owner',f.db,f.record.id,now)).status,404);
  for(const query of ['ownerId=other','attemptId='+attemptId+'&afterSequence=-1','attemptId='+attemptId+'&afterSequence=01','attemptId='+attemptId+'&afterSequence=1025','attemptId='+attemptId+'&attemptId=foreign'])assert.equal((await handleOwnerJobRead(new Request(base+'/events?'+query),owner,f.db,f.record.id,now,true)).status,400);
  const response=await handleOwnerJobRead(new Request(base+'/events?attemptId='+attemptId),owner,f.db,f.record.id,now,true);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store, private');assert.equal(jobEventPageSchema.parse(await response.json()).items.length,50);
 }finally{f.sqlite.close();}
});
test('artifact display schema never accepts public/device URLs, executable links or leaked unavailable metadata',()=>{
 const id='synthetic-artifact',ready={id,status:'ready',logicalType:'patch',filename:'review.patch.txt',mimeType:'text/plain',bytes:12,sha256:sha,href:'/api/attachments/'+id+'/content'};
 assert.equal(jobArtifactDisplaySchema.safeParse(ready).success,true);
 for(const href of ['https://public.example/file','javascript:alert(1)','/api/bridge/jobs/artifacts/'+id,'/api/attachments/foreign/content'])assert.equal(jobArtifactDisplaySchema.safeParse({...ready,href}).success,false);
 assert.equal(jobArtifactDisplaySchema.safeParse({...ready,status:'unavailable'}).success,false);
});

test('actual owner artifact projection links only bound ready verified ledger metadata and fails neutral after purge or foreign binding',async()=>{
 const f=await fixture();try{
  const id=crypto.randomUUID(),namespaces=await getWorkspaceNamespaces(f.db,owner);assert.ok(namespaces);const storageKey=attachmentStorageKey(namespaces.blobNamespace,id);
  const record={id,status:'ready',filename:'synthetic-review.patch.txt',mimeType:'text/plain',expectedBytes:12,actualBytes:12,sha256:sha,storageKey,createdAt:now,expiresAt:'2026-10-19T12:00:00.000Z',readyAt:now,uploadMutationId:'synthetic-upload',quarantineReason:null};
  // Metadata-only synthetic fixture. The owner download route independently
  // verifies real R2 bytes; this read does not claim physical file availability.
  f.sqlite.prepare('INSERT INTO attachments(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(owner,id,canonical(record),await contentHash(canonical(record)));
  f.sqlite.prepare('INSERT INTO agent_artifacts(user_id,attempt_id,artifact_id,logical_type,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(owner,attemptId,id,'patch',sha,12,now);
  f.sqlite.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,NULL)').run(owner,storageKey,id,namespaces.blobNamespace,12,sha,now,now);
  const result={attemptId,epoch:0,disposition:'succeeded',requestedModel:'gpt-6.1-sol',observedModel:'gpt-6.1-sol',modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[id],usage:null,diagnostic:'ok'};
  f.sqlite.prepare("UPDATE agent_job_state SET status='succeeded',result_json=? WHERE user_id=? AND job_id=?").run(canonical(result),owner,f.record.id);
  const ready=await readAgentJobDetail(f.db,owner,f.record.id,now);assert.ok(ready);assert.equal(ready.artifacts[0].status,'ready');assert.equal(ready.artifacts[0].href,'/api/attachments/'+id+'/content');
  f.sqlite.prepare('UPDATE attachment_blob_objects SET purged_at=? WHERE user_id=? AND attachment_id=?').run(now,owner,id);
  const purged=await readAgentJobDetail(f.db,owner,f.record.id,now);assert.equal(purged!.artifacts[0].status,'unavailable');assert.equal(purged!.artifacts[0].href,null);assert.equal(purged!.artifacts[0].filename,null);
  f.sqlite.prepare('DELETE FROM agent_artifacts WHERE user_id=?').run(owner);
  assert.equal((await readAgentJobDetail(f.db,owner,f.record.id,now))!.artifacts[0].status,'unavailable');
 }finally{f.sqlite.close();}
});

test('late operational attempt revision changes reject the event page atomically read from an older view',async()=>{
 const f=await fixture();try{
 let injected=false;
 function wrap(statement:SqlStatement):SqlStatement{return {bind(...values){return wrap(statement.bind(...values));},first:<T>()=>statement.first<T>(),run:()=>statement.run(),all:async<T>()=>{const result=await statement.all<T>();if(!injected){injected=true;f.sqlite.prepare('UPDATE job_attempts SET operational_revision=operational_revision+1 WHERE user_id=? AND id=?').run(owner,attemptId);}return result;}};}
 const raced:SqlDatabase={...f.db,prepare(sql){const statement=f.db.prepare(sql);return sql.startsWith('SELECT sequence,payload_json')?wrap(statement):statement;}};
 await assert.rejects(readAgentJobEvents(raced,owner,f.record.id,attemptId,now),/changed during read/);assert.equal(injected,true);
 }finally{f.sqlite.close();}
});
