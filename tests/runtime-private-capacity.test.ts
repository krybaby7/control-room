import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {ingestHeartbeat} from '../lib/runtime/store.ts';
import {pruneRuntime} from '../lib/runtime/retention.ts';
import {redeemDeviceEnrollment,registerDeviceSession,issueDeviceLiveWindow} from '../lib/devices/store.ts';
import {handleDeviceHttp} from '../lib/devices/http.ts';
import {authenticateDevice} from '../lib/devices/auth.ts';
import type {DevicePrincipal} from '../lib/devices/contracts.ts';
import type {HeartbeatEnvelopeV1} from '../lib/runtime/contracts.ts';
import {PRIVATE_PROFILE_TABLES} from '../lib/private-profile.ts';
import {privateCapacityGuard} from '../lib/private-capacity.ts';
const now='2026-10-18T12:00:00.000Z',at=(s:number)=>new Date(Date.parse(now)+s*1000).toISOString(),boot='00000000-0000-4000-8000-000000000001',windowId='00000000-0000-4000-8000-000000000002';
/** Synthetic direct rows exercise protocol storage, never a live device or ingress. */
async function fixture(owner='synthetic-owner'){
 const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);const project=(await readCurrent(f.db,owner,now)).workspace.projects[0].id;
 const display={id:'synthetic-device',label:'Synthetic PC',createdAt:now,archivedAt:null},configuration={id:'synthetic-configuration',deviceId:display.id,projectId:project,manifest:{id:'pc-command-center',version:1,enabled:true,capabilities:['read.health','read.summary'],endpointAlias:'synthetic-pc'},selectedGpuAlias:'selected-gpu'};
 f.sqlite.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at,archived_at) VALUES(?,?,1,?,?,?,NULL)').run(owner,display.id,canonical(display),await contentHash(canonical(display)),now);
 f.sqlite.prepare('INSERT INTO runtime_adapter_configurations(user_id,id,row_revision,payload_json,content_hash,device_id,project_id,source,instance_id) VALUES(?,?,1,?,?,?,?,?,?)').run(owner,configuration.id,canonical(configuration),await contentHash(canonical(configuration)),display.id,project,'pc-command-center','synthetic-pc');
 f.sqlite.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').run(owner,'synthetic-credential',display.id,await contentHash(owner+':synthetic-token'),canonical(['telemetry:write']),now,at(30*86400));
 f.sqlite.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation,current_boot_id) VALUES(?,?,1,0,1,?)').run(owner,display.id,boot);
 f.sqlite.prepare('INSERT INTO device_sessions(user_id,device_id,boot_id,generation,execution_epoch,bridge_version,created_at,compacted_through_sequence,last_window_sequence) VALUES(?,?,?,1,0,?,?,0,1)').run(owner,display.id,boot,'0.1.0-fixture',now);
 f.sqlite.prepare('INSERT INTO device_live_windows(user_id,device_id,id,boot_id,generation,sequence,execution_epoch,issued_at,expires_at) VALUES(?,?,?,?,1,1,0,?,?)').run(owner,display.id,windowId,boot,now,at(30));
 const principal:DevicePrincipal={ownerId:owner,deviceId:display.id,credentialId:'synthetic-credential',scopes:['telemetry:write']};
 const envelope:HeartbeatEnvelopeV1={schemaVersion:1,delivery:'live',liveWindowId:windowId,heartbeat:{schemaVersion:1,deviceId:display.id,bootId:boot,generation:1,sequence:1,sentAt:now,bridgeVersion:'0.1.0-fixture',observations:[{source:'pc-command-center',instanceId:'synthetic-pc',selectedGpuAlias:'selected-gpu',observedAt:at(-2),reportedAgeSeconds:2,state:'ready',diagnostic:'ok',metrics:{cpuPercent:10,memoryPercent:null,gpuUtilizationPercent:null,gpuMemoryUsedBytes:null,gpuMemoryTotalBytes:null,gpuTemperatureC:null,diskReadBytesPerSec:null,diskWriteBytesPerSec:null,networkSentBytesPerSec:null,networkReceivedBytesPerSec:null}}]}};
 return {...f,owner,principal,envelope,configuration,display};
}

const ingress={async verify(){return {serviceIdentity:'synthetic-private-ingress'};}};
async function seed(db:SqlDatabase,owner='a',deviceId='device-a',secret='synthetic_enrollment_00000000000000000000000000000001'){
 const display={id:deviceId,label:'Synthetic bridge',createdAt:now,archivedAt:null};
 await db.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at,archived_at) VALUES(?,?,1,?,?,?,NULL)').bind(owner,deviceId,canonical(display),await contentHash(canonical(display)),now).run();
 await db.prepare('INSERT INTO device_enrollments(user_id,id,device_id,secret_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').bind(owner,'enrollment-'+deviceId,deviceId,await contentHash(secret),'["telemetry:write"]',now,'2026-10-18T12:10:00.000Z').run();
 return {owner,deviceId,secret};
}
function request(token:string){return new Request('https://synthetic-private.invalid/api/devices/heartbeat',{method:'POST',headers:{'X-Control-Room-Device':token}});}
async function enrolled(db:SqlDatabase){const fixture=await seed(db),credential=await redeemDeviceEnrollment(db,{secret:fixture.secret,bridgeVersion:'synthetic-1.0'},{now,verifiedIngress:{serviceIdentity:'synthetic-private-ingress'}}),principal=await authenticateDevice(request(credential.deviceCredential),'telemetry:write',db,ingress,now);assert.ok(principal);return {...fixture,...credential,principal};}

/** Real SQLite pressure uses bounded valid cancelled intent rows, never live
 * jobs, synthetic success, a mocked guard result, or another owner's capacity. */
function saturate(f:ReturnType<typeof database>,owner:string){
 const payload=JSON.stringify('x'.repeat(1700000)),insert=f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'fixture.capacity',?,?,?,'cancelled',0,1)");
 f.sqlite.exec('BEGIN');try{for(let i=0;i<39;i++)insert.run(owner,'capacity-'+i,'capacity-'+i,payload,now);insert.run(owner,'capacity-tail','capacity-tail','""',now);f.sqlite.exec('COMMIT');}catch(error){f.sqlite.exec('ROLLBACK');throw error;}
 let used=0;for(const table of PRIVATE_PROFILE_TABLES){
  const columns=(f.sqlite.prepare('PRAGMA table_info('+table+')').all() as {name:string}[]).map(row=>row.name).filter(name=>name!=='user_id').sort();
  const json='json_object('+columns.flatMap(column=>["'"+column+"'",'"'+column+'"']).join(',')+')';
  used+=Number(f.sqlite.prepare('SELECT COALESCE(SUM(length(CAST('+json+' AS BLOB))+1),0) bytes FROM '+table+' WHERE user_id=?').get(owner)!.bytes);
 }
 used+=Number(f.sqlite.prepare("SELECT COALESCE(SUM(length(CAST(json_object('entity_id',entity_id,'entity_type',entity_type,'event_id',event_id,'kind',kind,'occurred_at',occurred_at,'payload_json',payload_json) AS BLOB))+1),0) bytes FROM audit_events WHERE user_id=? AND kind='entity.delete' AND entity_type IN('task','capture')").get(owner)!.bytes);
 const pending=Number(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE user_id=? AND settled_at IS NULL').get(owner)!.n)+Number(f.sqlite.prepare('SELECT COUNT(*) n FROM backup_archive_objects WHERE user_id=? AND pending_token IS NOT NULL AND settled_at IS NULL').get(owner)!.n);
 // The closed private profile reserves 64KiB for its envelope. Pending PUT
 // settlement retains its own additional4096 bytes, independent of raw rows.
 let tail=64*1024*1024-64*1024-used-pending*4096;assert.ok(tail>0&&tail<1700000);
 const write=()=>f.sqlite.prepare('UPDATE workspace_job_intents SET payload_json=? WHERE user_id=? AND id=?').run(JSON.stringify('x'.repeat(tail)),owner,'capacity-tail');write();
 return {release(bytes:number){assert.ok(bytes>=0&&bytes<=tail);tail-=bytes;write();}};
}
async function full(f:ReturnType<typeof database>,owner:string){
 const proof=await privateCapacityGuard(f.db,owner);assert.ok(await f.db.prepare('SELECT 1 WHERE '+proof.sql).bind(...proof.bindings).first(),'baseline fits exactly including reservations');
 const extra=await privateCapacityGuard(f.db,owner,{growth:[{table:'device_heartbeats',rows:0,bytes:1}]});assert.equal(await f.db.prepare('SELECT 1 WHERE '+extra.sql).bind(...extra.bindings).first(),null,'one more private byte does not fit');
}
test('heartbeat rejects full private capacity while retaining pending PUT headroom and every runtime value, then succeeds after real headroom opens',async()=>{
 const f=await fixture();try{
  const namespace=crypto.randomUUID(),attachmentId=crypto.randomUUID(),key='attachments/'+namespace+'/'+attachmentId,token=crypto.randomUUID();
  f.sqlite.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,1,NULL,?,NULL,NULL)').run(f.owner,key,attachmentId,namespace,now);
  f.sqlite.prepare('INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at) VALUES(?,?,?,?,?,NULL)').run(f.owner,token,attachmentId,key,now);
  const room=saturate(f,f.owner);await full(f,f.owner);
  const before=f.sqlite.prepare('SELECT * FROM device_runtime').get();await assert.rejects(ingestHeartbeat(f.db,f.principal,f.envelope,now));
  for(const table of ['device_heartbeats','runtime_observations','runtime_latest','runtime_minute_aggregates'])assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get()!.n,0);
  assert.equal(f.sqlite.prepare('SELECT consumed_at FROM device_live_windows').get()!.consumed_at,null);assert.deepEqual(f.sqlite.prepare('SELECT * FROM device_runtime').get(),before);assert.equal(f.sqlite.prepare('SELECT settled_at FROM attachment_upload_attempts').get()!.settled_at,null);
  room.release(20000);assert.equal((await ingestHeartbeat(f.db,f.principal,f.envelope,now)).classification,'live');
  assert.equal(f.sqlite.prepare('SELECT settled_at FROM attachment_upload_attempts').get()!.settled_at,null,'telemetry never consumes PUT-settlement reservation');
 }finally{f.sqlite.close();}
});
test('capacity filled after heartbeat precheck is rejected by the atomic claim without a partial receipt, latest, aggregate or clock',async()=>{
 const f=await fixture();try{
  let raced=false;const db:SqlDatabase={prepare:f.db.prepare.bind(f.db),async batch(statements){if(!raced){raced=true;saturate(f,f.owner);}return f.db.batch(statements);}};
  const before=f.sqlite.prepare('SELECT * FROM device_runtime').get();await assert.rejects(ingestHeartbeat(db,f.principal,f.envelope,now));
  assert.equal(raced,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_heartbeats').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_latest').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_minute_aggregates').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM device_live_windows').get()!.consumed_at,null);assert.deepEqual(f.sqlite.prepare('SELECT * FROM device_runtime').get(),before);
 }finally{f.sqlite.close();}
});
test('exact heartbeat replay stays read-only at full capacity and another owner pressure does not block native telemetry',async()=>{
 const f=await fixture();try{
  const receipt=await ingestHeartbeat(f.db,f.principal,f.envelope,now);saturate(f,f.owner);await full(f,f.owner);
  assert.deepEqual(await ingestHeartbeat(f.db,f.principal,f.envelope,at(1)),receipt);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_heartbeats').get()!.n,1);
 }finally{f.sqlite.close();}
 const other=await fixture();try{saturate(other,'synthetic-other-owner');assert.equal((await ingestHeartbeat(other.db,other.principal,other.envelope,now)).classification,'live');}finally{other.sqlite.close();}
});
test('enrollment admission refuses before consuming its secret or creating runtime/credential state, including a concurrent capacity race',async()=>{
 for(const race of [false,true]){
  const f=database();try{
   const value=await seed(f.db);if(!race)saturate(f,value.owner);
   let raced=false;const db:SqlDatabase=race?{prepare:f.db.prepare.bind(f.db),async batch(statements){if(!raced){raced=true;saturate(f,value.owner);}return f.db.batch(statements);}}:f.db;
   await assert.rejects(redeemDeviceEnrollment(db,{secret:value.secret,bridgeVersion:'synthetic-1.0'},{now,verifiedIngress:{serviceIdentity:'synthetic-private-ingress'}}));
   assert.equal(f.sqlite.prepare('SELECT consumed_at FROM device_enrollments').get()!.consumed_at,null);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_credentials').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_runtime').get()!.n,0);
  }finally{f.sqlite.close();}
 }
});
test('session and window positive growth respect capacity while exact existing boot/window retries remain available',async()=>{
 for(const stage of ['session','window'] as const){
  const f=database();try{
   const device=await enrolled(f.db),bootId=crypto.randomUUID();
   if(stage==='window')await registerDeviceSession(f.db,device.principal,{bootId,bridgeVersion:'synthetic-1.0'},now);
   saturate(f,device.owner);
   await assert.rejects(stage==='session'?registerDeviceSession(f.db,device.principal,{bootId,bridgeVersion:'synthetic-1.0'},now):issueDeviceLiveWindow(f.db,device.principal,{bootId,generation:1,sequence:1},now));
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_live_windows').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT current_generation FROM device_runtime').get()!.current_generation,stage==='session'?0:1);
  }finally{f.sqlite.close();}
 }
 const f=database();try{const device=await enrolled(f.db),bootId=crypto.randomUUID(),session=await registerDeviceSession(f.db,device.principal,{bootId,bridgeVersion:'synthetic-1.0'},now),window=await issueDeviceLiveWindow(f.db,device.principal,{bootId,generation:1,sequence:1},now);saturate(f,device.owner);assert.deepEqual(await registerDeviceSession(f.db,device.principal,{bootId,bridgeVersion:'synthetic-1.0'},now),session);assert.deepEqual(await issueDeviceLiveWindow(f.db,device.principal,{bootId,generation:1,sequence:1},now),window);}finally{f.sqlite.close();}
});
test('retention never takes speculative deletion credit for a positive monotonic floor extension',async()=>{
 const f=await fixture();try{
  f.envelope.heartbeat.sequence=10;f.sqlite.prepare('UPDATE device_live_windows SET sequence=10').run();f.sqlite.prepare('UPDATE device_sessions SET last_window_sequence=10').run();
  await ingestHeartbeat(f.db,f.principal,f.envelope,now);f.sqlite.prepare('UPDATE device_sessions SET compacted_through_sequence=9').run();
  const room=saturate(f,f.owner);await full(f,f.owner);await assert.rejects(pruneRuntime(f.db,f.owner,at(8*86400),{limit:100}));
  assert.equal(f.sqlite.prepare('SELECT compacted_through_sequence FROM device_sessions').get()!.compacted_through_sequence,9);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_heartbeats').get()!.n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_observations').get()!.n,1);
  room.release(2000);const result=await pruneRuntime(f.db,f.owner,at(8*86400),{limit:100});assert.equal(result.heartbeats,1);assert.equal(f.sqlite.prepare('SELECT compacted_through_sequence FROM device_sessions').get()!.compacted_through_sequence,10);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_latest').get()!.n,1);
 }finally{f.sqlite.close();}
});

test('actual authenticated heartbeat HTTP maps private-capacity refusal to sanitized409 without body or authority leakage',async()=>{
 const f=await fixture();try{
  const credential='b'.repeat(64);f.sqlite.prepare('UPDATE device_credentials SET token_hash=? WHERE user_id=?').run(await contentHash(credential),f.owner);
  saturate(f,f.owner);
  const request=new Request('https://synthetic-private.invalid/api/devices/heartbeat',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Room-Device':credential},body:JSON.stringify(f.envelope)});
  const response=await handleDeviceHttp('heartbeat',request,{db:f.db,ingress,now:()=>now,ingest:ingestHeartbeat});
  assert.equal(response.status,409);assert.equal(response.headers.get('cache-control'),'no-store, private');
  const body=await response.text();assert.deepEqual(JSON.parse(body),{error:'Device request was rejected.',code:'device_conflict'});
  assert.equal(body.includes(f.owner),false);assert.equal(body.includes(credential),false);assert.equal(body.includes('reserved'),false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_heartbeats').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM device_live_windows').get()!.consumed_at,null);
 }finally{f.sqlite.close();}
});
