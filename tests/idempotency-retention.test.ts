import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { checkMutationEpoch, issueMutationId, retireEpoch, mutationEpoch, MutationEpochError } from '../lib/idempotency-retention.ts';
function fixture() {
  const fixture=database();
  fixture.sqlite.exec("CREATE TABLE IF NOT EXISTS workspace_mutation_epochs (user_id TEXT NOT NULL, epoch TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','retired')), created_at TEXT NOT NULL, retired_at TEXT, PRIMARY KEY(user_id,epoch))");
  return fixture;
}
const at='2026-10-18T12:00:00.000Z';
test('server-issued IDs have owner-scoped active namespaces and stable replay checks',async()=>{
  const {db}=fixture();
  const first=await issueMutationId(db,'a',at),second=await issueMutationId(db,'a',at);
  assert.match(first,/^m1_[a-f0-9]{32}_[a-f0-9]{32}$/);
  assert.notEqual(first,second); assert.equal(mutationEpoch(first),mutationEpoch(second));
  assert.deepEqual(await checkMutationEpoch(db,'a',first),{status:'active',epoch:mutationEpoch(first)});
  assert.deepEqual(await checkMutationEpoch(db,'a',first),await checkMutationEpoch(db,'a',first));
  await assert.rejects(checkMutationEpoch(db,'b',first),e=>e instanceof MutationEpochError && e.code==='unknown-epoch');
});
test('retired epochs reject delayed outbox retries after detailed receipts disappear',async()=>{
  const {db,sqlite}=fixture(); const id=await issueMutationId(db,'a',at); const epoch=mutationEpoch(id)!;
  sqlite.prepare('INSERT INTO workspace_mutations (user_id, mutation_id, command_hash, revision, committed_at) VALUES (?, ?, ?, ?, ?)').run('a',id,'hash',2,at);
  assert.deepEqual(await retireEpoch(db,'a',epoch,at),{epoch,status:'retired',compactionAllowed:true});
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_mutations').get()!.n,1);
  sqlite.prepare('DELETE FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?').run('a',id);
  assert.equal((await checkMutationEpoch(db,'a',id)).status,'retired');
  const next=await issueMutationId(db,'a',at); assert.notEqual(mutationEpoch(next),epoch);
  assert.equal((await checkMutationEpoch(db,'a',id)).status,'retired');
});
test('legacy UUID and existing IDs never acquire removable epoch authority',async()=>{
  const {db,sqlite}=fixture(); const id='00000000-0000-4000-8000-000000000000';
  sqlite.prepare('INSERT INTO workspace_mutations (user_id, mutation_id, command_hash, revision, committed_at) VALUES (?, ?, ?, ?, ?)').run('a',id,'old',2,at);
  const newId=await issueMutationId(db,'a',at); await retireEpoch(db,'a',mutationEpoch(newId)!,at);
  assert.deepEqual(await checkMutationEpoch(db,'a',id),{status:'legacy'});
  assert.deepEqual(await checkMutationEpoch(db,'b',id),{status:'legacy'});
  assert.equal(sqlite.prepare('SELECT command_hash FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?').get('a',id)!.command_hash,'old');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_mutations WHERE user_id = ?').get('b')!.n,0);
});
test('retirement is irreversible, owner isolated, and unaffected by clock skew',async()=>{
  const {db,sqlite}=fixture(); const id=await issueMutationId(db,'a','2099-01-01T00:00:00Z'); const epoch=mutationEpoch(id)!;
  await Promise.all([retireEpoch(db,'a',epoch,at),checkMutationEpoch(db,'a',id)]);
  assert.equal((await checkMutationEpoch(db,'a',id)).status,'retired');
  await retireEpoch(db,'a',epoch,'2000-01-01T00:00:00Z');
  assert.equal(sqlite.prepare('SELECT retired_at FROM workspace_mutation_epochs WHERE user_id = ? AND epoch = ?').get('a',epoch)!.retired_at,at);
  await retireEpoch(db,'b',epoch,at);
  assert.equal((await checkMutationEpoch(db,'b',id)).status,'retired');
  assert.equal((await checkMutationEpoch(db,'a',await issueMutationId(db,'a','1999-01-01T00:00:00Z'))).status,'active');
});
test('reserved namespaces reject malformed and unissued IDs; missing owner cannot manage epochs',async()=>{
  const {db}=fixture();
  for(const id of ['m1_fake_epoch_random','m1_'+'a'.repeat(32)+'_'+'b'.repeat(31)]) await assert.rejects(checkMutationEpoch(db,'a',id),/invalid/);
  await assert.rejects(checkMutationEpoch(db,'a',`m1_${'a'.repeat(32)}_${'b'.repeat(32)}`),/not issued/);
  await assert.rejects(issueMutationId(db,'',at),/signed-in/);
  await assert.rejects(retireEpoch(db,'a','bad',at),/invalid/);
});
test('command admission guards resolve retirement races atomically and preserve legacy receipts across restore',async()=>{
  const {db,sqlite}=fixture();
  sqlite.exec('CREATE TABLE test_effects (user_id TEXT NOT NULL, mutation_id TEXT NOT NULL, PRIMARY KEY(user_id,mutation_id))');
  const before=await issueMutationId(db,'a',at),epoch=mutationEpoch(before)!;
  // A transaction may win admission before retirement. Its consumed ID remains consumed.
  await db.batch([
    db.prepare("INSERT INTO test_effects SELECT ?, ? WHERE EXISTS (SELECT 1 FROM workspace_mutation_epochs WHERE user_id = ? AND epoch = ? AND status = 'active') ON CONFLICT DO NOTHING").bind('a',before,'a',epoch),
  ]);
  await retireEpoch(db,'a',epoch,at);
  const delayed=`m1_${epoch}_${'c'.repeat(32)}`;
  await db.batch([
    db.prepare("INSERT INTO test_effects SELECT ?, ? WHERE EXISTS (SELECT 1 FROM workspace_mutation_epochs WHERE user_id = ? AND epoch = ? AND status = 'active') ON CONFLICT DO NOTHING").bind('a',delayed,'a',epoch),
  ]);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM test_effects').get()!.n,1);
  assert.equal((await checkMutationEpoch(db,'a',before)).status,'retired');
  assert.equal((await checkMutationEpoch(db,'a',delayed)).status,'retired');
  // Replacing planning content has no authority to replace epoch or receipt tables.
  sqlite.prepare('INSERT INTO workspaces (user_id,content,revision,updated_at) VALUES (?,?,?,?)').run('a','{"schemaVersion":1}',1,at);
  sqlite.prepare('UPDATE workspaces SET content = ?, revision = revision + 1 WHERE user_id = ?').run('{"schemaVersion":3}','a');
  assert.equal((await checkMutationEpoch(db,'a',before)).status,'retired');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM test_effects').get()!.n,1);
});

// Exercise the production executor, rather than duplicating its admission SQL.
import { executeWorkspaceCommand, mutationOutcome } from '../lib/workspace-transaction.ts';
import { loadWorkspace, type SqlDatabase } from '../lib/workspace-store.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { workspaceHandlers } from '../lib/workspace-handlers.ts';
import { RetiredMutationError } from '../lib/workspace-errors.ts';
const captured={type:'capture.create',capture:{title:'Once',body:'Retained',projectId:null,kind:'idea',sourceUrl:null}};
async function seedOwner(db:SqlDatabase,user='a') { return loadWorkspace(db,user,()=>createSeedWorkspace(at),at); }
test('real executor checks retirement before receipt replay and outcome even after receipt compaction',async()=>{
  const {db,sqlite}=fixture(); const original=await seedOwner(db); const id=await issueMutationId(db,'a',at);
  const input={protocolVersion:1,expectedRevision:1,mutationId:id,command:captured};
  const deps={db,now:()=>at,handlers:workspaceHandlers};
  assert.equal((await executeWorkspaceCommand('a',input,deps)).status,'committed');
  assert.equal((await executeWorkspaceCommand('a',input,deps)).status,'replayed');
  await retireEpoch(db,'a',mutationEpoch(id)!,at);
  await assert.rejects(executeWorkspaceCommand('a',input,deps),RetiredMutationError);
  assert.deepEqual(await mutationOutcome(db,'a',id),{status:'retired',retryAllowed:false});
  sqlite.prepare('DELETE FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?').run('a',id);
  await assert.rejects(executeWorkspaceCommand('a',input,deps),RetiredMutationError);
  assert.deepEqual(await mutationOutcome(db,'a',id),{status:'retired',retryAllowed:false});
  const current=await seedOwner(db);
  assert.equal(current.revision,2); assert.equal(current.workspace.captures.length,original.workspace.captures.length+1);
});
test('retirement after real executor preflight but before batch creates no receipt or effects',async()=>{
  const {db,sqlite}=fixture(); const original=await seedOwner(db); const id=await issueMutationId(db,'a',at);
  let entered=false;
  const raced:SqlDatabase={prepare:db.prepare.bind(db),async batch(statements){
    entered=true; await retireEpoch(db,'a',mutationEpoch(id)!,at); return db.batch(statements);
  }};
  await assert.rejects(executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:1,mutationId:id,command:captured},{db:raced,now:()=>at,handlers:workspaceHandlers}),RetiredMutationError);
  assert.equal(entered,true); assert.deepEqual(await seedOwner(db),original);
  for(const table of ['workspace_mutations','workspace_command_guards','workspace_assertions','audit_events','workspace_job_intents']) assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0,table);
});
test('real legacy UUID receipt replays after workspace restore without duplicating content',async()=>{
  const {db,sqlite}=fixture(); const original=await seedOwner(db); const id='9ab12cde-1234-4567-89ab-123456789abc';
  const deps={db,now:()=>at,handlers:workspaceHandlers};
  const input={protocolVersion:1,expectedRevision:1,mutationId:id,command:captured};
  assert.equal((await executeWorkspaceCommand('a',input,deps)).status,'committed');
  const restored=await executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:2,mutationId:'legacy-restore-0001',command:{type:'workspace.restore',workspace:original.workspace}},deps);
  assert.equal(restored.status,'committed');
  const replayed=await executeWorkspaceCommand('a',{...input,expectedRevision:3},deps);
  if(replayed.status==='conflict')assert.fail('Unexpected conflict');
  assert.equal(replayed.status,'replayed');
  assert.equal(replayed.envelope.revision,3);
  assert.deepEqual(replayed.envelope.workspace,original.workspace);
  assert.equal(replayed.receipt.appliedRevision,2);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?').get('a',id)!.n,1);
  assert.equal((await mutationOutcome(db,'a',id)).status,'committed');
});
