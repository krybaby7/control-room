import assert from 'node:assert/strict';
import type {SqlDatabase} from '../../lib/workspace-store.ts';
import {loadWorkspace,readCurrent} from '../../lib/workspace-store.ts';
import {createSeedWorkspace} from '../../lib/seed.ts';
import {canonical,contentHash} from '../../lib/canonical-json.ts';
import {encodePlanning} from '../../lib/workspace-codec.ts';
import {readOperationalWatermarks} from '../../lib/operational-watermarks.ts';
import {captureRecoveryPrivateContinuity} from '../../lib/recovery-private-continuity.ts';
import {inspectRecoveryMaintenanceSchema,prepareRecoveryMaintenance,freezeRecoveryDatabase,verifyFrozenRecoveryDatabase,bindFrozenPrivateContinuity,assertRecoveryBlobCopyEligible,prepareInactiveRecoveryTarget,writeInactiveRecoveryTarget,recoveryTargetInventorySha256,markRecoveryTargetReady,releaseRecoverySource,RECOVERY_APPLICATION_TABLES} from '../../lib/recovery-maintenance.ts';

export async function runRecoveryMaintenanceFixture(source:SqlDatabase,target:SqlDatabase){
 const owner='synthetic-maintenance-owner',foreign='synthetic-maintenance-other',now='2026-10-18T12:00:00.000Z',sha='a'.repeat(64),token='b'.repeat(64);
 await loadWorkspace(source,owner,()=>createSeedWorkspace(now),now);
 const original=(await readCurrent(source,owner,now)).workspace,namespace=crypto.randomUUID(),attachmentId=crypto.randomUUID(),oldKey='attachments/'+namespace+'/'+attachmentId;
 // This old key can have a late DELETE in flight. It is permanently excluded,
 // never copied as a ready file, and its exact fence remains private continuity.
 await source.prepare('INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,NULL)').bind(owner,oldKey,attachmentId,namespace,crypto.randomUUID(),now).run();
 await source.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,NULL)').bind(owner,oldKey,attachmentId,namespace,12,sha,now,now).run();
 await source.prepare("INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,'active',?,NULL)").bind(owner,'c'.repeat(32),now).run();
 await source.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').bind(owner,'retained-legacy-mutation',sha,1,now).run();
 // A global unique credential conflict across owners exercises REPLACE safety.
 const display={id:'synthetic-device',label:'Synthetic maintenance credential fixture',createdAt:now,archivedAt:null};await source.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?)').bind(owner,display.id,canonical(display),await contentHash(canonical(display)),now).run();
 await source.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').bind(owner,'synthetic-existing-credential','synthetic-device',sha,'["telemetry:write"]',now,'2026-10-19T12:00:00.000Z').run();
 const profile=await inspectRecoveryMaintenanceSchema(source);assert.equal(profile.tables,RECOVERY_APPLICATION_TABLES.length);
 const expected={operationId:crypto.randomUUID(),token,ownerId:owner,manifestSha256:sha,ownerContextHash:await contentHash(owner),schemaFingerprint:profile.schemaFingerprint,sourceContext:{workspaceRevision:1,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(source,owner)},now};
 await prepareRecoveryMaintenance(source,profile.schemaFingerprint);
 // A whole-binding cutover cannot freeze/export only one of two owners.
 await source.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,1,?)').bind(foreign,encodePlanning(original),now).run();
 await assert.rejects(freezeRecoveryDatabase(source,expected),/Single-owner recovery source/);
 assert.equal((await source.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(foreign).first<{revision:number}>())!.revision,1);
 assert.equal((await source.prepare('SELECT COUNT(*) count FROM operator_recovery_maintenance').first<{count:number}>())!.count,0);
 await source.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').bind(foreign).run();
 // Explicit synthetic fixture teardown only, after proving refusal preserves it.
 await source.prepare('DELETE FROM workspaces WHERE user_id=?').bind(foreign).run();
 // A pending PUT blocks the entire DB maintenance fence.
 const pending=crypto.randomUUID();
 await source.prepare('INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at) VALUES(?,?,?,?,?,NULL)').bind(owner,pending,attachmentId,oldKey,now).run();
 await assert.rejects(freezeRecoveryDatabase(source,expected),/unsettled writes/);
 await source.prepare('UPDATE attachment_upload_attempts SET settled_at=? WHERE user_id=? AND token=?').bind(now,owner,pending).run();
 const frozen=await freezeRecoveryDatabase(source,expected);
 assert.deepEqual(await freezeRecoveryDatabase(source,expected),frozen);await verifyFrozenRecoveryDatabase(source,frozen);
 await assert.rejects(verifyFrozenRecoveryDatabase(source,{...frozen,token:'f'.repeat(64)}),/authority/);
 await assert.rejects(source.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').bind(owner).run(),/operator_recovery_frozen/);
 await assert.rejects(source.prepare('DELETE FROM workspaces WHERE user_id=?').bind(owner).run(),/operator_recovery_frozen/);
 await assert.rejects(source.prepare('INSERT OR REPLACE INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').bind(foreign,'synthetic-replacement','synthetic-device',sha,'["telemetry:write"]',now,'2026-10-19T12:00:00.000Z').run(),/operator_recovery_frozen/);
 await assert.rejects(source.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').bind(foreign,'forbidden-late-write',sha,1,now).run(),/operator_recovery_frozen/);
 assert.equal((await source.prepare('SELECT user_id FROM device_credentials WHERE token_hash=?').bind(sha).first<{user_id:string}>())!.user_id,owner);
 await assert.rejects(assertRecoveryBlobCopyEligible(source,frozen,oldKey),/fenced or cleanup-claimed/);
 const privateValue=await captureRecoveryPrivateContinuity(source,owner,{manifestSha256:sha,ownerContextHash:expected.ownerContextHash,sourceContext:expected.sourceContext},now);
 await assert.rejects(bindFrozenPrivateContinuity(source,frozen,privateValue,'f'.repeat(64)));
 await bindFrozenPrivateContinuity(source,frozen,privateValue,privateValue.sha256);
 const inactive=await prepareInactiveRecoveryTarget(target,source,frozen,{operationId:crypto.randomUUID(),token:'d'.repeat(64),expectedPrivateSha256:privateValue.sha256});
 await assert.rejects(target.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,1,?)').bind(owner,encodePlanning(original),now).run(),/operator_recovery_frozen/);
 const statements=[
  target.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,1,?)').bind(owner,encodePlanning(original),now),
  target.prepare('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?)').bind(owner,now),
  target.prepare('INSERT INTO workspace_source_namespaces(user_id,audit_namespace,blob_namespace,cursor_secret) VALUES(?,?,?,?)').bind(owner,privateValue.sourceNamespaces.audit_namespace,crypto.randomUUID(),'e'.repeat(64)),
 ];
 await assert.rejects(writeInactiveRecoveryTarget(target,inactive,[...statements,target.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) VALUES(?,?,0)').bind(owner,'synthetic-atomic-fault')]));
 assert.equal((await target.prepare('SELECT COUNT(*) n FROM workspaces').first<{n:number}>())!.n,0);
 await assert.rejects(target.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,1,?)').bind(owner,encodePlanning(original),now).run(),/operator_recovery_frozen/);
 await writeInactiveRecoveryTarget(target,inactive,statements);
 // Preserve exact-key anti-resurrection and legacy replay history; retire the old epoch.
 const fences=privateValue.tables.attachment_blob_fences,objects=privateValue.tables.attachment_blob_objects;
 await writeInactiveRecoveryTarget(target,inactive,[
  target.prepare('INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,?)').bind(owner,fences[0].storage_key,fences[0].attachment_id,fences[0].namespace,fences[0].token,fences[0].created_at,fences[0].purged_at),
  target.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(owner,objects[0].storage_key,objects[0].attachment_id,objects[0].namespace,objects[0].bytes,objects[0].sha256,objects[0].created_at,objects[0].verified_at,objects[0].purged_at),
  target.prepare("INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,'retired',?,?)").bind(owner,'c'.repeat(32),now,now),
  target.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').bind(owner,'retained-legacy-mutation',sha,1,now),
 ]);
 assert.deepEqual((await readCurrent(target,owner,now)).workspace,original);
 const sourceNamespace=await source.prepare('SELECT audit_namespace,blob_namespace,cursor_secret FROM workspace_source_namespaces WHERE user_id=?').bind(owner).first<{audit_namespace:string;blob_namespace:string;cursor_secret:string}>();
 const targetNamespace=await target.prepare('SELECT audit_namespace,blob_namespace,cursor_secret FROM workspace_source_namespaces WHERE user_id=?').bind(owner).first<{audit_namespace:string;blob_namespace:string;cursor_secret:string}>();assert.ok(sourceNamespace);assert.ok(targetNamespace);
 const namespacePatches:Record<string,string>[]=[{audit_namespace:crypto.randomUUID()},{cursor_secret:sourceNamespace.cursor_secret},{blob_namespace:sourceNamespace.blob_namespace}];
 for(const patch of namespacePatches){
  const [column,value]=Object.entries(patch)[0];
  await writeInactiveRecoveryTarget(target,inactive,[target.prepare('UPDATE workspace_source_namespaces SET '+column+'=? WHERE user_id=?').bind(value,owner)]);
  const badNamespaceInventory=await recoveryTargetInventorySha256(target,inactive);
  await assert.rejects(markRecoveryTargetReady(target,source,frozen,inactive,{privateSha256:privateValue.sha256,inventorySha256:badNamespaceInventory,actualInventorySha256:()=>recoveryTargetInventorySha256(target,inactive)}),/native identity|cursor|namespace/);
  await writeInactiveRecoveryTarget(target,inactive,[target.prepare('UPDATE workspace_source_namespaces SET audit_namespace=?,blob_namespace=?,cursor_secret=? WHERE user_id=?').bind(targetNamespace.audit_namespace,targetNamespace.blob_namespace,targetNamespace.cursor_secret,owner)]);
 }
 const inventory=await recoveryTargetInventorySha256(target,inactive);
 await assert.rejects(markRecoveryTargetReady(target,source,frozen,inactive,{privateSha256:privateValue.sha256,inventorySha256:'f'.repeat(64),actualInventorySha256:()=>recoveryTargetInventorySha256(target,inactive)}),/inventory differs/);
 // A concurrent trusted installer batch changes the CAS even if the verifier was
 // otherwise honest; the final marker cannot attest to an earlier target image.
 await assert.rejects(markRecoveryTargetReady(target,source,frozen,inactive,{privateSha256:privateValue.sha256,inventorySha256:inventory,actualInventorySha256:async()=>{await writeInactiveRecoveryTarget(target,inactive,[target.prepare('UPDATE workspace_source_namespaces SET audit_namespace=? WHERE user_id=?').bind(crypto.randomUUID(),owner)]);return inventory;}}),/changed during verification/);
 await writeInactiveRecoveryTarget(target,inactive,[target.prepare('UPDATE workspace_source_namespaces SET audit_namespace=? WHERE user_id=?').bind(sourceNamespace.audit_namespace,owner)]);
 const finalInventory=await recoveryTargetInventorySha256(target,inactive);
 await markRecoveryTargetReady(target,source,frozen,inactive,{privateSha256:privateValue.sha256,inventorySha256:finalInventory,actualInventorySha256:()=>recoveryTargetInventorySha256(target,inactive)});
 await assert.rejects(target.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').bind(owner).run(),/operator_recovery_frozen/);
 await assert.rejects(writeInactiveRecoveryTarget(target,inactive,[target.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').bind(owner)]),/authority/);
 assert.equal((await target.prepare('SELECT COUNT(*) n FROM device_credentials').first<{n:number}>())!.n,0);
 const restoredFence=await target.prepare('SELECT storage_key,purged_at FROM attachment_blob_fences').first<{storage_key:string;purged_at:string|null}>();assert.ok(restoredFence);assert.deepEqual({...restoredFence},{storage_key:oldKey,purged_at:null});
 assert.equal((await target.prepare('SELECT status FROM workspace_mutation_epochs').first<{status:string}>())!.status,'retired');
 await assert.rejects(releaseRecoverySource(source,frozen,{operationId:frozen.operationId,reason:'no'}),/Explicit reviewed/);
 await releaseRecoverySource(source,frozen,{operationId:frozen.operationId,reason:'Synthetic fixture rollback after verifying the inactive target.'});
 await source.prepare('UPDATE workspaces SET revision=revision WHERE user_id=?').bind(owner).run();
 await assert.rejects(verifyFrozenRecoveryDatabase(source,frozen),/authority/);
 assert.equal((await target.prepare('SELECT state FROM operator_recovery_maintenance').first<{state:string}>())!.state,'target-ready');
 return {tables:RECOVERY_APPLICATION_TABLES.length,guards:RECOVERY_APPLICATION_TABLES.length*3,privateSha256:privateValue.sha256,inventorySha256:finalInventory,oldKey,sourceReceipt:frozen};
}
