import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactFixture,artifactNow as now,artifactLater as later} from './fixtures/agent-artifact.ts';
import {privateCapacityGuard,PRIVATE_REVOCATION_POOL} from '../lib/private-capacity.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readCurrent} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {deviceAuthorityGuard} from '../lib/devices/auth.ts';
import {renewAgentLease} from '../lib/agents/store.ts';
test('all20 native first revocations spend finite safety slots at capacity while historical timestamps and unknown execution survive',{timeout:180000},async()=>{
 const f=await artifactFixture();try{
  const ids=[f.principal.deviceId],past='2026-10-17T12:00:00.000Z',expired='2026-10-17T12:00:30.000Z';
  for(let index=1;index<20;index++){
   const id='synthetic-revoke-device-'+index,display={id,label:'Synthetic revocation '+index,createdAt:now,archivedAt:null};ids.push(id);
   f.sqlite.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?)').run(f.owner,id,canonical(display),await contentHash(canonical(display)),now);
   f.sqlite.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').run(f.owner,'synthetic-revoke-credential-'+index,id,await contentHash('synthetic-private-credential-'+index),canonical(['telemetry:write']),now,later(3600));
   f.sqlite.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation) VALUES(?,?,1,0,0)').run(f.owner,id);
  }
  const session=f.sqlite.prepare('INSERT INTO device_sessions(user_id,device_id,boot_id,generation,execution_epoch,bridge_version,created_at,retired_at,last_window_sequence) VALUES(?,?,?,?,0,?,?,?,?)');
  for(let index=1;index<=255;index++)session.run(f.owner,ids[0],crypto.randomUUID(),index,'0.1.0',past,past,0);
  const boot=crypto.randomUUID();session.run(f.owner,ids[0],boot,256,'0.1.0',now,null,1001);
  f.sqlite.prepare('UPDATE device_runtime SET current_generation=256,current_boot_id=? WHERE user_id=? AND device_id=?').run(boot,f.owner,ids[0]);
  const window=f.sqlite.prepare('INSERT INTO device_live_windows(user_id,device_id,id,boot_id,generation,sequence,execution_epoch,issued_at,expires_at,consumed_at) VALUES(?,?,?,?,256,?,0,?,?,NULL)');
  for(let index=1;index<=1000;index++)window.run(f.owner,ids[0],crypto.randomUUID(),boot,index,past,expired);
  const currentWindow=crypto.randomUUID();window.run(f.owner,ids[0],currentWindow,boot,1001,now,later(30));
  const retiredBefore=canonical(f.sqlite.prepare('SELECT * FROM device_sessions WHERE user_id=? AND retired_at IS NOT NULL ORDER BY boot_id').all(f.owner)),expiredBefore=canonical(f.sqlite.prepare('SELECT * FROM device_live_windows WHERE user_id=? AND expires_at=? ORDER BY id').all(f.owner,expired));
  async function allowed(epochRows:number){const proof=await privateCapacityGuard(f.db,f.owner,{growth:[{table:'workspace_mutations',rows:99000,bytes:0},{table:'workspace_mutation_epochs',rows:epochRows,bytes:0}]});return (await f.db.prepare('SELECT 1 WHERE '+proof.sql).bind(...proof.bindings).first())!==null;}
  let low=0,high=100000;while(low<high){const middle=Math.ceil((low+high)/2);if(await allowed(middle))low=middle;else high=middle-1;}assert.ok(low>97000);
  f.sqlite.exec('BEGIN IMMEDIATE');try{
   const receipt=f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)');for(let index=0;index<99000;index++)receipt.run(f.owner,'retained-revocation-capacity-'+String(index).padStart(8,'0'),'a'.repeat(64),1,now);
   const epoch=f.sqlite.prepare("INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,'retired',?,?)");for(let index=0;index<low;index++)epoch.run(f.owner,index.toString(16).padStart(32,'0'),now,now);
   f.sqlite.exec('COMMIT');
  }catch(error){f.sqlite.exec('ROLLBACK');throw error;}
  const before=await readCurrent(f.db,f.owner,now);assert.notEqual(await deviceAuthorityGuard(f.db,f.principal,now),null);
  for(const [index,id]of ids.entries()){
   const current=await readCurrent(f.db,f.owner,now);
   const result=await executeWorkspaceCommand(f.owner,{protocolVersion:1,expectedRevision:current.revision,mutationId:'funded-device-revocation-'+String(index).padStart(16,'0'),command:{type:'devices.revoke',id,expectedRowRevision:1}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.equal(result.status,'committed');
   assert.equal(f.sqlite.prepare('SELECT revoked_at FROM device_runtime WHERE user_id=? AND device_id=?').get(f.owner,id)!.revoked_at,now);
  }
  assert.equal(PRIVATE_REVOCATION_POOL.devices,20);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(f.owner)!.n,99020);
  assert.equal(await deviceAuthorityGuard(f.db,f.principal,now),null);
  await assert.rejects(()=>renewAgentLease(f.db,f.principal,{attemptId:f.lease.attemptId,leaseToken:f.lease.leaseToken},f.options));
  assert.equal(canonical(f.sqlite.prepare('SELECT * FROM device_sessions WHERE user_id=? AND retired_at=? ORDER BY boot_id').all(f.owner,past)),retiredBefore);
  assert.equal(canonical(f.sqlite.prepare('SELECT * FROM device_live_windows WHERE user_id=? AND expires_at=? ORDER BY id').all(f.owner,expired)),expiredBefore);
  assert.equal(f.sqlite.prepare('SELECT consumed_at FROM device_live_windows WHERE user_id=? AND id=?').get(f.owner,currentWindow)!.consumed_at,now);
  assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots WHERE user_id=?').get(f.owner)!.released_at,null);
  assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets WHERE user_id=?').get(f.owner)!.reserved_seconds,120);
  assert.equal(f.sqlite.prepare('SELECT result_json FROM job_attempts WHERE user_id=? AND id=?').get(f.owner,f.lease.attemptId)!.result_json,null);
  assert.deepEqual((await readCurrent(f.db,f.owner,now)).workspace,before.workspace);
  for(let index=0;index<3;index++){const current=await readCurrent(f.db,f.owner,now);await assert.rejects(()=>executeWorkspaceCommand(f.owner,{protocolVersion:1,expectedRevision:current.revision,mutationId:'unfunded-device-noop-'+String(index).padStart(16,'0'),command:{type:'devices.revoke',id:ids[0],expectedRowRevision:1}},{db:f.db,handlers:workspaceHandlers,now:()=>now}));}
  const display=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM devices WHERE user_id=? AND id=?').get(f.owner,ids[0])!.payload_json as string),current=await readCurrent(f.db,f.owner,now);
  await assert.rejects(()=>executeWorkspaceCommand(f.owner,{protocolVersion:1,expectedRevision:current.revision,mutationId:'unfunded-device-reenrollment-0001',command:{type:'devices.enrollment.create',value:{deviceId:ids[0],label:display.label,scopes:['telemetry:write']}}},{db:f.db,handlers:workspaceHandlers,now:()=>now,deviceEnrollment:{id:crypto.randomUUID(),deviceId:ids[0],secretHash:'b'.repeat(64),expiresAt:later(600),scopes:['telemetry:write']}}));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(f.owner)!.n,99020);assert.equal(f.sqlite.prepare('SELECT revoked_at FROM device_runtime WHERE user_id=? AND device_id=?').get(f.owner,ids[0])!.revoked_at,now);
 }finally{f.sqlite.close();}
});
