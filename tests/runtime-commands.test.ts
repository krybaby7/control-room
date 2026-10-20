import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {ownerReader,type RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import {moduleColumnNames,moduleProjection} from '../lib/module-columns.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {deviceRuntimeHandlers} from '../lib/runtime/commands.ts';
import {deviceControlStatements} from '../lib/runtime/transaction-controls.ts';
import type {PrepareContext,MutationPlan} from '../lib/workspace-transaction.ts';
import type {JsonValue,WorkspaceCommand} from '../lib/workspace-protocol.ts';
import type {RuntimeObservationV1,SelectedRuntimeEvidence} from '../lib/runtime/contracts.ts';
const owner='synthetic-device-owner',foreign='synthetic-foreign-owner',now='2026-10-18T12:00:00.000Z',expires='2026-10-18T12:10:00.000Z',boot='11111111-1111-4111-8111-111111111111';
async function fixture(){
 const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);await loadWorkspace(f.db,foreign,()=>createSeedWorkspace(now),now);f.sqlite.exec('PRAGMA foreign_keys=ON');
 async function put(table:RegisteredOwnerTable,id:string,value:unknown,userId=owner){const columns=moduleColumnNames(table),projection=await moduleProjection(table,id,value as JsonValue),text=canonical(value);f.sqlite.prepare('INSERT INTO '+table+'(user_id,id,row_revision,payload_json,content_hash'+(columns.length?','+columns.join(','):'')+') VALUES(?,?,1,?,?'+(columns.length?','+columns.map(()=>'?').join(','):'')+')').run(userId,id,text,await contentHash(text),...columns.map(column=>projection[column]));}
 const material={id:'synthetic-enrollment',deviceId:'synthetic-device',secretHash:'a'.repeat(64),expiresAt:expires,scopes:['telemetry:write'] as ['telemetry:write']};
 let latest:Omit<SelectedRuntimeEvidence,'id'|'origin'>|null=null;
 async function prepare(command:WorkspaceCommand,patch:Partial<PrepareContext>={}):Promise<MutationPlan>{
  const handler=deviceRuntimeHandlers.get(command.type);assert.ok(handler);
  return handler.prepare({userId:owner,before:await readCurrent(f.db,owner,now),command,now,query:ownerReader(f.db,owner),readImport:async()=>{throw new Error('No staged import in this fixture.');},deviceRuntime:{enrollment:material,latest:async()=>latest},...patch});
 }
 async function compile(plan:MutationPlan,type:string,beforeBatch?:()=>void,claimPresent=true){
  const mutationId=crypto.randomUUID(),guard=[owner,mutationId,crypto.randomUUID()],claim='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?)',controls=await deviceControlStatements(f.db,owner,plan,type,claim,guard,now);
  const statements=claimPresent?[f.db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...guard)]:[];
  for(const write of plan.writes){
   const columns=moduleColumnNames(write.table),projection=await moduleProjection(write.table,write.id,write.value!),text=canonical(write.value),hash=await contentHash(text);
   if(write.operation==='insert')statements.push(f.db.prepare('INSERT INTO '+write.table+'(user_id,id,row_revision,payload_json,content_hash'+(columns.length?','+columns.join(','):'')+') SELECT ?,?,1,?,?'+(columns.length?','+columns.map(()=>'?').join(','):'')+' WHERE '+claim).bind(owner,write.id,text,hash,...columns.map(column=>projection[column]),...guard));
   else if(write.operation==='update')statements.push(f.db.prepare('UPDATE '+write.table+' SET row_revision=row_revision+1,payload_json=?,content_hash=?'+columns.map(column=>','+column+'=?').join('')+' WHERE user_id=? AND id=? AND row_revision=? AND '+claim).bind(text,hash,...columns.map(column=>projection[column]),owner,write.id,write.expectedRowRevision,...guard));
   else throw new Error('Unexpected fixture delete');
  }
  statements.push(...controls,f.db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=?').bind(owner,mutationId));beforeBatch?.();return f.db.batch(statements);
 }
 async function display(id=material.deviceId,userId=owner){await put('devices',id,{id,label:'Synthetic PC',createdAt:now,archivedAt:null},userId);}
 async function seedAuthority(){
  f.sqlite.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation,current_boot_id,last_live_received_at,revoked_at,last_request_at) VALUES(?,?,1,0,3,?,?,NULL,NULL)').run(owner,material.deviceId,boot,now);
  f.sqlite.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at,revoked_at,rotation_retire_at) VALUES(?,?,?,?,?,0,?,?,NULL,NULL)').run(owner,'synthetic-old-credential',material.deviceId,'b'.repeat(64),'["telemetry:write"]',now,expires);
  f.sqlite.prepare('INSERT INTO device_enrollments(user_id,id,device_id,secret_hash,scopes_json,execution_epoch,created_at,expires_at,consumed_at,revoked_at) VALUES(?,?,?,?,?,0,?,?,NULL,NULL)').run(owner,'synthetic-old-enrollment',material.deviceId,'c'.repeat(64),'["telemetry:write"]',now,expires);
  f.sqlite.prepare('INSERT INTO device_sessions(user_id,device_id,boot_id,generation,execution_epoch,bridge_version,created_at,retired_at,compacted_through_sequence,last_window_sequence) VALUES(?,?,?,3,0,?,?,NULL,0,1)').run(owner,material.deviceId,boot,'0.1.0',now);
  f.sqlite.prepare('INSERT INTO device_live_windows(user_id,device_id,id,boot_id,generation,sequence,execution_epoch,issued_at,expires_at,consumed_at) VALUES(?,?,?,?,3,1,0,?,?,NULL)').run(owner,material.deviceId,'synthetic-old-window',boot,now,'2026-10-18T12:00:30.000Z');
 }
 async function seedLatest(){
  const observation:RuntimeObservationV1={source:'pc-command-center',instanceId:'pc-command-center',observedAt:now,reportedAgeSeconds:1,state:'ready',diagnostic:'ok',metrics:null};
  const receipt={heartbeatHash:'d'.repeat(64),bootId:boot,generation:3,sequence:1,receivedAt:now,classification:'live',reason:'live_window',transportAgeUpperBoundSeconds:0};
  const payloadHash=await contentHash(canonical(observation));
  f.sqlite.prepare('INSERT INTO runtime_latest(user_id,device_id,source,instance_id,generation,sequence,boot_id,payload_json,payload_hash,receipt_json,last_successful_sample_at) VALUES(?,?,?,?,3,1,?,?,?,?,?)').run(owner,material.deviceId,observation.source,observation.instanceId,boot,canonical(observation),payloadHash,canonical(receipt),now);
  latest={deviceId:material.deviceId,source:observation.source,instanceId:observation.instanceId,observedAt:now,reportedAgeSeconds:1,receivedAt:now,payloadHash,observation,heartbeatRef:{bootId:boot,generation:3,sequence:1,hash:receipt.heartbeatHash}};
  return {type:'runtime.evidence.select',deviceId:material.deviceId,source:observation.source,instanceId:observation.instanceId,expectedPayloadHash:payloadHash,expectedHeartbeatHash:receipt.heartbeatHash} as WorkspaceCommand;
 }
 return {...f,material,put,prepare,compile,display,seedAuthority,seedLatest};
}
const enrollment=(deviceId?:string):WorkspaceCommand=>({type:'devices.enrollment.create',value:{label:'Synthetic PC',...(deviceId?{deviceId}:{}),scopes:['telemetry:write']}});
test('owner enrollment creates immutable display identity and private digest without planning or authority leaks',async()=>{
 const f=await fixture();try{const before=await readCurrent(f.db,owner,now),plan=await f.prepare(enrollment());assert.deepEqual(plan.planningAfter,before.workspace);assert.equal(plan.jobs.length,0);assert.equal(plan.writes.length,1);assert.ok(!canonical(plan.events).includes(f.material.secretHash));await f.compile(plan,'devices.enrollment.create');
 const privateRow=f.sqlite.prepare('SELECT * FROM device_enrollments WHERE user_id=?').get(owner)!;assert.equal(privateRow.secret_hash,f.material.secretHash);assert.equal(privateRow.execution_epoch,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_credentials').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM devices WHERE user_id=?').get(foreign)!.n,0);assert.deepEqual((await readCurrent(f.db,owner,now)).workspace,before.workspace);
 }finally{f.sqlite.close();}
});
test('enrollment rejects untrusted secret fields, foreign display, mismatched material and device capacity',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.prepare({...enrollment(),secret:'plaintext'}));await assert.rejects(f.prepare({...enrollment(),value:{label:'Synthetic PC',scopes:['jobs:poll']}}));
  await f.display('synthetic-foreign-device',foreign);await assert.rejects(f.prepare(enrollment('synthetic-foreign-device')));
  await assert.rejects(f.prepare(enrollment(),{deviceRuntime:{enrollment:{...f.material,expiresAt:now},latest:async()=>null}}));
  for(let index=0;index<20;index++)await f.display('synthetic-limit-'+index);await assert.rejects(f.prepare(enrollment()));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_enrollments').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('explicit re-enrollment atomically revokes prior credentials/windows/sessions and preserves original display createdAt',async()=>{
 const f=await fixture();try{await f.display();await f.seedAuthority();const before=f.sqlite.prepare('SELECT * FROM devices WHERE user_id=?').get(owner),plan=await f.prepare(enrollment(f.material.deviceId));assert.equal(plan.writes.length,0);await f.compile(plan,'devices.enrollment.create');
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM devices WHERE user_id=?').get(owner),before);
 assert.equal(f.sqlite.prepare('SELECT revoked_at FROM device_credentials').get()!.revoked_at,now);assert.equal(f.sqlite.prepare('SELECT revoked_at FROM device_enrollments WHERE id=?').get('synthetic-old-enrollment')!.revoked_at,now);assert.equal(f.sqlite.prepare('SELECT retired_at FROM device_sessions').get()!.retired_at,now);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM device_live_windows').get()!.consumed_at,now);
 const runtime=f.sqlite.prepare('SELECT * FROM device_runtime').get()!;assert.equal(runtime.current_generation,4);assert.equal(runtime.operational_revision,2);assert.equal(runtime.execution_epoch,0);assert.equal(runtime.revoked_at,null);assert.equal(runtime.current_boot_id,null);
 }finally{f.sqlite.close();}
});
test('plain revoke requires exact owner revision and keeps device revoked; private failure rolls back entire enrollment',async()=>{
 const f=await fixture();try{await f.display();await f.seedAuthority();await assert.rejects(f.prepare({type:'devices.revoke',id:f.material.deviceId,expectedRowRevision:2}));const plan=await f.prepare({type:'devices.revoke',id:f.material.deviceId,expectedRowRevision:1});await f.compile(plan,'devices.revoke');assert.equal(f.sqlite.prepare('SELECT revoked_at FROM device_runtime').get()!.revoked_at,now);
 f.sqlite.exec("CREATE TRIGGER synthetic_enrollment_fault BEFORE INSERT ON device_enrollments BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");const before=f.sqlite.prepare('SELECT * FROM device_runtime').get();await assert.rejects(f.compile(await f.prepare(enrollment(f.material.deviceId)),'devices.enrollment.create'));assert.deepEqual(f.sqlite.prepare('SELECT * FROM device_runtime').get(),before);
 }finally{f.sqlite.close();}
});
test('configuration is strict owner-linked fixed PC read-only state, never executable planning',async()=>{
 const f=await fixture();try{await f.display();const value={deviceId:f.material.deviceId,projectId:null,manifest:{id:'pc-command-center',version:1,enabled:true,capabilities:['read.health','read.summary'],endpointAlias:'pc-command-center'},selectedGpuAlias:'nvidia-1'},command={type:'runtime.adapter.configure',value} as WorkspaceCommand;
 const plan=await f.prepare(command);await f.compile(plan,command.type);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_adapter_configurations').get()!.n,1);
 await assert.rejects(f.prepare(command));await assert.rejects(f.prepare({...command,value:{...value,manifest:{...value.manifest,id:'trade-graph',endpointAlias:'trade-graph'}}} as WorkspaceCommand));
 await assert.rejects(f.prepare({...command,id:plan.writes[0].id}));await assert.rejects(f.prepare({...command,value:{...value,manifest:{...value.manifest,endpointAlias:'private-path'}}} as WorkspaceCommand));
 const update=await f.prepare({...command,id:plan.writes[0].id,expectedRowRevision:1,value:{...value,selectedGpuAlias:'nvidia-2'}} as WorkspaceCommand);await f.compile(update,command.type);assert.equal(f.sqlite.prepare('SELECT row_revision FROM runtime_adapter_configurations').get()!.row_revision,2);
 assert.equal(update.jobs.length,0);assert.deepEqual(update.planningAfter,(await readCurrent(f.db,owner,now)).workspace);
 }finally{f.sqlite.close();}
});
test('selected evidence freezes exact latest copy after raw retention and guards receipt/payload races atomically',async()=>{
 const f=await fixture();try{await f.display();const command=await f.seedLatest(),plan=await f.prepare(command);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_heartbeats').get()!.n,0);await f.compile(plan,command.type);const value=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM runtime_evidence').get()!.payload_json as string);assert.equal(value.origin,'native-device');assert.equal(value.heartbeatRef.hash,command.expectedHeartbeatHash);
 await assert.rejects(f.prepare({...command,expectedPayloadHash:'e'.repeat(64)}));const next=await f.prepare(command);
 await assert.rejects(f.compile(next,command.type,()=>f.sqlite.prepare('UPDATE runtime_latest SET receipt_json=json_set(receipt_json,?,?)').run('$.transportAgeUpperBoundSeconds',1)));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_evidence').get()!.n,1);
 }finally{f.sqlite.close();}
});
test('missing central claim cannot initialize device authority and other command kinds cannot reuse private controls',async()=>{
 const f=await fixture();try{const plan=await f.prepare(enrollment());await f.compile(plan,'devices.enrollment.create',undefined,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM devices').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_enrollments').get()!.n,0);await assert.rejects(f.compile(plan,'workspace.import.commit'));}finally{f.sqlite.close();}
});

test('competing device creates cannot exceed the twenty-device boundary',async()=>{
 const f=await fixture();try{
  for(let index=0;index<19;index++)await f.display('synthetic-existing-'+index);
  const first=await f.prepare(enrollment());
  const secondMaterial={...f.material,id:'synthetic-second-enrollment',deviceId:'synthetic-second-device',secretHash:'f'.repeat(64)};
  const second=await f.prepare(enrollment(),{deviceRuntime:{enrollment:secondMaterial,latest:async()=>null}});
  await f.compile(first,'devices.enrollment.create');await assert.rejects(f.compile(second,'devices.enrollment.create'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM devices WHERE user_id=?').get(owner)!.n,20);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM devices WHERE user_id=? AND id=?').get(owner,secondMaterial.deviceId)!.n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_enrollments WHERE user_id=?').get(owner)!.n,1);
 }finally{f.sqlite.close();}
});
test('selected evidence capacity and unknown authority fields fail closed',async()=>{
 const f=await fixture();try{
  await f.display();const command=await f.seedLatest(),plan=await f.prepare(command);
  await assert.rejects(f.prepare({...command,accepted:true}));
  const original=plan.writes[0].value as Record<string,JsonValue>;
  for(let index=0;index<500;index++){const id='synthetic-frozen-'+index;await f.put('runtime_evidence',id,{...original,id});}
  await assert.rejects(f.prepare(command));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_evidence WHERE user_id=?').get(owner)!.n,500);
 }finally{f.sqlite.close();}
});
