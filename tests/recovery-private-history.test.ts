import test from 'node:test';import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {ingestHeartbeat} from '../lib/runtime/store.ts';
import type {DevicePrincipal} from '../lib/devices/contracts.ts';
import type {HeartbeatEnvelopeV1} from '../lib/runtime/contracts.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {captureRecoveryPrivateContinuity} from '../lib/recovery-private-continuity.ts';
import {inactiveRecoveryDatabase,installRecoveryPrivateContinuity} from '../lib/recovery-install.ts';
import {inspectRecoveryMaintenanceSchema,freezeRecoveryDatabase,bindFrozenPrivateContinuity,prepareInactiveRecoveryTarget,recoveryTargetInventorySha256,markRecoveryTargetReady} from '../lib/recovery-maintenance.ts';
const now='2026-10-18T12:00:00.000Z',at=(s:number)=>new Date(Date.parse(now)+s*1000).toISOString(),boot='00000000-0000-4000-8000-000000000001',windowId='00000000-0000-4000-8000-000000000002';
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

test('actual native heartbeat, dated latest, aggregate and sequence floors survive recovery while device authority is revoked',async()=>{
 const source=await fixture(),target=database();try{
  const receipt=await ingestHeartbeat(source.db,source.principal,source.envelope,now);
  const current=await readCurrent(source.db,source.owner,now),schema=await inspectRecoveryMaintenanceSchema(source.db);
  const sourceContext={workspaceRevision:current.revision,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(source.db,source.owner)},ownerContextHash=await contentHash(source.owner),manifestSha256='a'.repeat(64);
  const frozen=await freezeRecoveryDatabase(source.db,{operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:source.owner,manifestSha256,ownerContextHash,schemaFingerprint:schema.schemaFingerprint,sourceContext,now});
  const value=await captureRecoveryPrivateContinuity(source.db,source.owner,{manifestSha256,ownerContextHash,sourceContext},now);
  await bindFrozenPrivateContinuity(source.db,frozen,value,value.sha256);
  const destination=await prepareInactiveRecoveryTarget(target.db,source.db,frozen,{operationId:crypto.randomUUID(),token:'c'.repeat(64),expectedPrivateSha256:value.sha256}),db=inactiveRecoveryDatabase(target.db,destination);
  await loadWorkspace(db,source.owner,()=>current.workspace,now);
  for(const table of ['devices','runtime_adapter_configurations']as const){
   const columns=source.sqlite.prepare('PRAGMA table_info('+table+')').all().map(row=>String(row.name));assert.ok(columns.every(column=>/^[a-z_][a-z0-9_]*$/.test(column)));
   for(const row of source.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=?').all(source.owner))await db.prepare('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').bind(...columns.map(column=>{const value=row[column];if(value===null||typeof value==='string'||typeof value==='number')return value;throw new Error('Unexpected fixture scalar.');})).run();
  }
  await installRecoveryPrivateContinuity(source.db,frozen,target.db,destination,value,value.sha256);
  for(const table of ['device_heartbeats','runtime_latest','runtime_observations','runtime_minute_aggregates','device_live_windows']as const)assert.deepEqual(target.sqlite.prepare('SELECT * FROM '+table).all(),source.sqlite.prepare('SELECT * FROM '+table).all(),table);
  assert.equal(target.sqlite.prepare('SELECT receipt_json FROM device_heartbeats').get()!.receipt_json,canonical(receipt));
  assert.equal(target.sqlite.prepare('SELECT last_window_sequence FROM device_sessions').get()!.last_window_sequence,1);
  assert.equal(target.sqlite.prepare('SELECT retired_at FROM device_sessions').get()!.retired_at,now);
  assert.equal(target.sqlite.prepare('SELECT revoked_at FROM device_runtime').get()!.revoked_at,now);
  assert.equal(target.sqlite.prepare('SELECT last_live_received_at FROM device_runtime').get()!.last_live_received_at,now);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) count FROM device_credentials').get()!.count,0);
  const inventorySha256=await recoveryTargetInventorySha256(target.db,destination);await markRecoveryTargetReady(target.db,source.db,frozen,destination,{privateSha256:value.sha256,inventorySha256,actualInventorySha256:()=>recoveryTargetInventorySha256(target.db,destination)});
  await assert.rejects(ingestHeartbeat(target.db,source.principal,source.envelope,now),/authority|credential|device/i);
 }finally{source.sqlite.close();target.sqlite.close();}
});
