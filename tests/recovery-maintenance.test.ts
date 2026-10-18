import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {contentHash} from '../lib/canonical-json.ts';
import {runRecoveryMaintenanceFixture} from './helpers/recovery-maintenance.ts';
import {inspectRecoveryMaintenanceSchema,freezeRecoveryDatabase,RECOVERY_APPLICATION_TABLES} from '../lib/recovery-maintenance.ts';
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
   const statement=source.db.prepare(sql);if(!sql.startsWith('INSERT INTO operator_recovery_maintenance'))return statement;
   const bind=statement.bind.bind(statement);
   return {...statement,bind(...values:(string|number|null)[]){const bound=bind(...values);return {...bound,async run(){if(!changed){changed=true;source.sqlite.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').run(owner);}return bound.run();},first:bound.first.bind(bound),all:bound.all.bind(bound),bind:bound.bind.bind(bound)};},first:statement.first.bind(statement),all:statement.all.bind(statement),run:statement.run.bind(statement)};
  },batch:source.db.batch.bind(source.db)};
  await assert.rejects(freezeRecoveryDatabase(raced,{operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:owner,manifestSha256:'a'.repeat(64),ownerContextHash:await contentHash(owner),schemaFingerprint:profile.schemaFingerprint,sourceContext:{workspaceRevision:1,executionEpoch:0,operationalWatermarks:{sources:0}},now}),/Source changed/);
  assert.equal(source.sqlite.prepare('SELECT COUNT(*) n FROM operator_recovery_maintenance').get()!.n,0);
  source.sqlite.prepare('UPDATE workspaces SET revision=3 WHERE user_id=?').run(owner);
 }finally{source.sqlite.close();}
});
