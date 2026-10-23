import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {runRecoveryMaintenanceFixture} from './helpers/recovery-maintenance.ts';
import {inspectRecoveryMaintenanceSchema,prepareRecoveryMaintenance,verifyFrozenRecoveryDatabase,freezeRecoveryDatabase,RECOVERY_APPLICATION_TABLES} from '../lib/recovery-maintenance.ts';
test('actual SQLite DB-wide freeze, inactive atomic target and manual-only handoff preserve fences and reject REPLACE',async()=>{
 const source=database(),target=database();try{const result=await runRecoveryMaintenanceFixture(source.db,target.db);assert.equal(result.tables,RECOVERY_APPLICATION_TABLES.length);assert.equal(result.guards,RECOVERY_APPLICATION_TABLES.length*3);}finally{source.sqlite.close();target.sqlite.close();}
});
test('unknown tables fail before an operator lock exists',async()=>{
 const source=database();try{
  source.sqlite.exec('CREATE TABLE unreviewed_future_authority(user_id TEXT)');
  await assert.rejects(inspectRecoveryMaintenanceSchema(source.db),/Unsupported recovery application table inventory/);
  assert.equal(source.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='operator_recovery_maintenance'").get(),undefined);
 }finally{source.sqlite.close();}
});
test('source context races prevent freeze; application writes remain available after refusal',async()=>{
 const source=database(),owner='synthetic-raced-freeze',now='2026-10-18T12:00:00.000Z';try{
  await loadWorkspace(source.db,owner,()=>createSeedWorkspace(now),now);const profile=await inspectRecoveryMaintenanceSchema(source.db);
  let changed=false;
  const raced={prepare(sql:string){
   const statement=source.db.prepare(sql);if(!sql.includes('INSERT INTO operator_recovery_maintenance'))return statement;
   const bind=statement.bind.bind(statement);
   return {...statement,bind(...values:(string|number|null)[]){const bound=bind(...values);return {...bound,async run(){if(!changed){changed=true;source.sqlite.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').run(owner);}return bound.run();},first:bound.first.bind(bound),all:bound.all.bind(bound),bind:bound.bind.bind(bound)};},first:statement.first.bind(statement),all:statement.all.bind(statement),run:statement.run.bind(statement)};
  },batch:source.db.batch.bind(source.db)};
  await assert.rejects(freezeRecoveryDatabase(raced,{operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:owner,manifestSha256:'a'.repeat(64),ownerContextHash:await contentHash(owner),schemaFingerprint:profile.schemaFingerprint,sourceContext:{workspaceRevision:1,executionEpoch:0,operationalWatermarks:{sources:0}},now}),/Source changed/);
  assert.equal(source.sqlite.prepare('SELECT COUNT(*) n FROM operator_recovery_maintenance').get()!.n,0);
  source.sqlite.prepare('UPDATE workspaces SET revision=3 WHERE user_id=?').run(owner);
 }finally{source.sqlite.close();}
});

test('actual deferred history PUT rejects freeze until physical settlement and leaves late bytes safely retained',async()=>{
 const {stageHistoryObject}=await import('../lib/history/object-store.ts'),{readOperationalWatermarks}=await import('../lib/operational-watermarks.ts'),{captureRecoveryPrivateContinuity,assessPrivateRecoveryContinuity}=await import('../lib/recovery-private-continuity.ts');
 for(const outcome of ['ready','revoked']){const source=database(),owner='synthetic-pending-history-'+outcome,now='2026-10-22T12:00:00.000Z';let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),objects=new Map<string,Uint8Array>();let allowed=true;try{
  await loadWorkspace(source.db,owner,()=>createSeedWorkspace(now),now);const profile=await inspectRecoveryMaintenanceSchema(source.db),sourceContext={workspaceRevision:1,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(source.db,owner)},input={operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:owner,manifestSha256:'a'.repeat(64),ownerContextHash:await contentHash(owner),schemaFingerprint:profile.schemaFingerprint,sourceContext,now},bytes=new TextEncoder().encode('Synthetic late history object bytes');
  const attempt=stageHistoryObject({db:source.db,authorize:async()=>allowed,now:()=>now,bucket:{async put(key,value){entered();await gate;objects.set(key,value.slice());},async get(key){return objects.get(key)??null;},async delete(){assert.fail('an unsettled/late PUT must not be deleted');}}},{ownerId:owner,sourceId:'synthetic-source',epoch:'source-epoch',scopeRevision:1,bytes,sha256:await contentHash(bytes)}).then(value=>({value,error:null}),error=>({value:null,error}));
  await started;const pending=source.sqlite.prepare('SELECT * FROM history_object_ledger WHERE user_id=?').get(owner)!;assert.equal(pending.status,'staging');assert.equal(typeof pending.pending_token,'string');
  const continuity=await captureRecoveryPrivateContinuity(source.db,owner,{manifestSha256:input.manifestSha256,ownerContextHash:input.ownerContextHash,sourceContext},now);assert.ok(assessPrivateRecoveryContinuity(continuity).blockers.includes('unsettled_history_put'));
  await assert.rejects(freezeRecoveryDatabase(source.db,input),/unsettled writes/);assert.equal(source.sqlite.prepare('SELECT COUNT(*) n FROM operator_recovery_maintenance').get()!.n,0);assert.equal(source.sqlite.prepare('SELECT pending_token FROM history_object_ledger WHERE user_id=?').get(owner)!.pending_token,pending.pending_token);assert.equal(objects.size,0);
  if(outcome==='revoked')allowed=false;release();const settled=await attempt;if(outcome==='ready')assert.equal(settled.error,null);else assert.match(String(settled.error),/access denied/);
  const row=source.sqlite.prepare('SELECT * FROM history_object_ledger WHERE user_id=?').get(owner)!;assert.equal(row.status,outcome==='ready'?'ready':'abandoned');assert.equal(row.pending_token,null);assert.deepEqual(objects.get(String(row.key)),bytes);
  const settledContinuity=await captureRecoveryPrivateContinuity(source.db,owner,{manifestSha256:input.manifestSha256,ownerContextHash:input.ownerContextHash,sourceContext},now);assert.ok(!assessPrivateRecoveryContinuity(settledContinuity).blockers.includes('unsettled_history_put'));
  const frozen=await freezeRecoveryDatabase(source.db,input);assert.equal(frozen.role,'source');await assert.rejects(source.db.prepare('UPDATE history_object_ledger SET pending_token=? WHERE user_id=?').bind('forbidden-late-token',owner).run(),/operator_recovery_frozen/);assert.deepEqual(objects.get(String(row.key)),bytes);
 }finally{release?.();source.sqlite.close();}}
});
test('either unsettled history token or staging state independently blocks atomic freeze',async()=>{
 const {readOperationalWatermarks}=await import('../lib/operational-watermarks.ts');
 for(const [status,token] of [['ready','persisted-pending-token'],['staging',null]] as const){const source=database(),owner='synthetic-unsettled-history-flag',now='2026-10-22T12:00:00.000Z';try{
  await loadWorkspace(source.db,owner,()=>createSeedWorkspace(now),now);const profile=await inspectRecoveryMaintenanceSchema(source.db),input={operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:owner,manifestSha256:'a'.repeat(64),ownerContextHash:await contentHash(owner),schemaFingerprint:profile.schemaFingerprint,sourceContext:{workspaceRevision:1,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(source.db,owner)},now};
  source.sqlite.prepare('INSERT INTO history_object_ledger(user_id,key,source_id,epoch,scope_revision,sha256,bytes,status,pending_token,created_at) VALUES(?,?,?,?,1,?,0,?,?,?)').run(owner,'history/synthetic/flag','synthetic-source','source-epoch','c'.repeat(64),status,token,now);
  await assert.rejects(freezeRecoveryDatabase(source.db,input),/unsettled writes/);assert.equal(source.sqlite.prepare('SELECT COUNT(*) n FROM operator_recovery_maintenance').get()!.n,0);
 }finally{source.sqlite.close();}}
});

test('a previously persisted freeze with an unsettled history put is rejected by frozen verification and exact retry',async()=>{
 const source=database(),owner='synthetic-old-frozen-history',now='2026-10-22T12:00:00.000Z';try{
  await loadWorkspace(source.db,owner,()=>createSeedWorkspace(now),now);const profile=await inspectRecoveryMaintenanceSchema(source.db),{readOperationalWatermarks}=await import('../lib/operational-watermarks.ts'),input={operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:owner,manifestSha256:'a'.repeat(64),ownerContextHash:await contentHash(owner),schemaFingerprint:profile.schemaFingerprint,sourceContext:{workspaceRevision:1,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(source.db,owner)},now};
  source.sqlite.prepare("INSERT INTO history_object_ledger(user_id,key,source_id,epoch,scope_revision,sha256,bytes,status,pending_token,created_at) VALUES(?,?,?,?,1,?,0,'staging',?,?)").run(owner,'history/synthetic/old-pending','synthetic-source','source-epoch','c'.repeat(64),'original-unsettled-token',now);
  await prepareRecoveryMaintenance(source.db,profile.schemaFingerprint);
  // Synthetic pre-fix persisted control: the old freeze admitted this pending PUT.
  source.sqlite.prepare("INSERT INTO operator_recovery_maintenance(singleton,operation_id,token_hash,role,state,owner_id,manifest_hash,owner_context_hash,schema_hash,source_context_json,created_at) VALUES(1,?,?,'source','source-frozen',?,?,?,?,?,?)").run(input.operationId,await contentHash(input.token),owner,input.manifestSha256,input.ownerContextHash,input.schemaFingerprint,canonical(input.sourceContext),now);
  await assert.rejects(verifyFrozenRecoveryDatabase(source.db,{...input,role:'source',createdAt:now}),/Frozen source continuity differs/);await assert.rejects(freezeRecoveryDatabase(source.db,input),/Frozen source continuity differs/);assert.equal(source.sqlite.prepare('SELECT pending_token FROM history_object_ledger').get()!.pending_token,'original-unsettled-token');
 }finally{source.sqlite.close();}
});
test('history staging admitted after freeze preflight is rejected by the final atomic insertion guard',async()=>{
 const source=database(),owner='synthetic-racing-history',now='2026-10-22T12:00:00.000Z';try{
  await loadWorkspace(source.db,owner,()=>createSeedWorkspace(now),now);const profile=await inspectRecoveryMaintenanceSchema(source.db),{readOperationalWatermarks}=await import('../lib/operational-watermarks.ts'),input={operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:owner,manifestSha256:'a'.repeat(64),ownerContextHash:await contentHash(owner),schemaFingerprint:profile.schemaFingerprint,sourceContext:{workspaceRevision:1,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(source.db,owner)},now};let raced=false;
  const db={...source.db,prepare(sql:string){const statement=source.db.prepare(sql);if(!sql.includes('INSERT INTO operator_recovery_maintenance'))return statement;return {...statement,bind(...values:(string|number|null)[]){statement.bind(...values);return this;},async run(){if(!raced){raced=true;source.sqlite.prepare("INSERT INTO history_object_ledger(user_id,key,source_id,epoch,scope_revision,sha256,bytes,status,pending_token,created_at) VALUES(?,?,?,?,1,?,0,'staging',?,?)").run(owner,'history/synthetic/racing','synthetic-source','source-epoch','c'.repeat(64),'active-at-freeze-insert',now);}return statement.run();}};}};
  await assert.rejects(freezeRecoveryDatabase(db,input),/unsettled writes/);assert.equal(raced,true);assert.equal(source.sqlite.prepare('SELECT COUNT(*) n FROM operator_recovery_maintenance').get()!.n,0);source.sqlite.prepare("UPDATE history_object_ledger SET status='abandoned',pending_token=NULL WHERE user_id=?").run(owner);assert.equal((await freezeRecoveryDatabase(source.db,input)).role,'source');
 }finally{source.sqlite.close();}
});
