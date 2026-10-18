import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactFixture,artifactNow} from './fixtures/agent-artifact.ts';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {contentHash} from '../lib/canonical-json.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {renewAgentLease} from '../lib/agents/store.ts';
import {captureRecoveryPrivateContinuity} from '../lib/recovery-private-continuity.ts';
import {inactiveRecoveryDatabase,installRecoveryPrivateContinuity} from '../lib/recovery-install.ts';
import {inspectRecoveryMaintenanceSchema,freezeRecoveryDatabase,bindFrozenPrivateContinuity,prepareInactiveRecoveryTarget,recoveryTargetInventorySha256,markRecoveryTargetReady} from '../lib/recovery-maintenance.ts';
function scalar(value:unknown):string|number|null{if(value===null||typeof value==='string'||typeof value==='number')return value;throw new Error('Unexpected synthetic SQL scalar.');}
test('actual first claim frozen admission and task input survive inert private recovery byte-for-byte',async()=>{
 const source=await artifactFixture(),target=database();try{
  const before=source.sqlite.prepare('SELECT * FROM job_attempts WHERE user_id=?').get(source.owner)!;
  const originalIdentity=String(before.identity_json),identity=JSON.parse(originalIdentity);
  assert.deepEqual(identity.taskInput,source.lease.taskInput);assert.deepEqual(identity.frozenAdmission,source.lease.frozenAdmission);
  assert.ok(identity.approvalEnvelope);assert.equal(identity.frozenAdmission.ownerContextHash,await contentHash(source.owner));
  const current=await readCurrent(source.db,source.owner,artifactNow),schema=await inspectRecoveryMaintenanceSchema(source.db),sha='a'.repeat(64);
  const sourceContext={workspaceRevision:current.revision,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(source.db,source.owner)},ownerContextHash=await contentHash(source.owner);
  const receipt=await freezeRecoveryDatabase(source.db,{operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:source.owner,manifestSha256:sha,ownerContextHash,schemaFingerprint:schema.schemaFingerprint,sourceContext,now:artifactNow});
  const value=await captureRecoveryPrivateContinuity(source.db,source.owner,{manifestSha256:sha,ownerContextHash,sourceContext},artifactNow);
  assert.equal(value.tables.job_attempts[0].identity_json,originalIdentity);
  await bindFrozenPrivateContinuity(source.db,receipt,value,value.sha256);
  const targetReceipt=await prepareInactiveRecoveryTarget(target.db,source.db,receipt,{operationId:crypto.randomUUID(),token:'c'.repeat(64),expectedPrivateSha256:value.sha256}),writable=inactiveRecoveryDatabase(target.db,targetReceipt);
  await loadWorkspace(writable,source.owner,()=>current.workspace,artifactNow);
  // Exact native records from this real synthetic claim; no portable identity
  // remapping or fabricated receipt/result is involved.
  for(const table of ['devices','agent_jobs','audit_events'] as const){
   const columns=source.sqlite.prepare('PRAGMA table_info('+table+')').all().map(row=>String(row.name));assert.ok(columns.every(column=>/^[a-z_][a-z0-9_]*$/.test(column)));
   for(const row of source.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=?').all(source.owner))await writable.prepare('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').bind(...columns.map(column=>scalar(row[column]))).run();
  }
  await installRecoveryPrivateContinuity(source.db,receipt,target.db,targetReceipt,value,value.sha256);
  const restored=target.sqlite.prepare('SELECT * FROM job_attempts WHERE user_id=?').get(source.owner)!;
  assert.equal(restored.identity_json,originalIdentity);assert.equal(restored.journal_nonce_hash,before.journal_nonce_hash);assert.equal(restored.lease_token_hash,before.lease_token_hash);
  assert.deepEqual(JSON.parse(String(restored.identity_json)).frozenAdmission,identity.frozenAdmission);
  assert.deepEqual(JSON.parse(String(restored.identity_json)).taskInput,identity.taskInput);
  assert.equal(target.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'reconcile_required');
  assert.equal(target.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);
  assert.equal(target.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,source.record.spec.timeoutSeconds);
  assert.equal(target.sqlite.prepare('SELECT enabled FROM agent_budgets').get()!.enabled,0);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) count FROM device_credentials').get()!.count,0);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) count FROM agent_capabilities').get()!.count,0);
  const inventorySha256=await recoveryTargetInventorySha256(target.db,targetReceipt);
  await markRecoveryTargetReady(target.db,source.db,receipt,targetReceipt,{privateSha256:value.sha256,inventorySha256,actualInventorySha256:()=>recoveryTargetInventorySha256(target.db,targetReceipt)});
  await assert.rejects(renewAgentLease(target.db,source.principal,{attemptId:source.lease.attemptId,leaseToken:source.lease.leaseToken},source.options),/credential|authority|device/);
 }finally{source.sqlite.close();target.sqlite.close();}
});
