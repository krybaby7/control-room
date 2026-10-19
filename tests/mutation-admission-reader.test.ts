import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {MutationEpochError,checkMutationEpoch} from '../lib/idempotency-retention.ts';
import {executeWorkspaceCommand,hashJson,type CommandHandlerRegistry} from '../lib/workspace-transaction.ts';
import {RetiredMutationError,MutationIdReuseError} from '../lib/workspace-errors.ts';
import {readMutationAdmission,classifyMutationAdmission} from '../lib/mutation-admission-reader.ts';
const now='2026-10-18T12:00:00.000Z',owner='admission-owner',foreign='admission-foreign',epoch='a'.repeat(32),hash='b'.repeat(64),legacyHash='c'.repeat(64),id='m1_'+epoch+'_'+'d'.repeat(32);
async function fixture(){const f=database();for(const user of [owner,foreign])await loadWorkspace(f.db,user,()=>createSeedWorkspace(now),now);return f;}
function issue(f:Awaited<ReturnType<typeof fixture>>,user=owner,status='active'){f.sqlite.prepare('INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,?,?,?)').run(user,epoch,status,now,status==='retired'?now:null);}
function receipt(f:Awaited<ReturnType<typeof fixture>>,user=owner,mutationId=id,commandHash=hash,revision=2){f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').run(user,mutationId,commandHash,revision,now);}
const decision=(snapshot:Awaited<ReturnType<typeof readMutationAdmission>>,expectedRevision=1)=>classifyMutationAdmission(snapshot,{commandHash:hash,legacyHash,expectedRevision});
test('actual owner epoch receipt and revision share exactly one read-only SQL statement',async()=>{
 const f=await fixture();try{issue(f);receipt(f);f.sqlite.prepare('UPDATE workspaces SET revision=5 WHERE user_id=?').run(owner);let queries=0;
  const observed:SqlDatabase={prepare(sql){queries++;assert.equal(sql.trimStart().startsWith('SELECT'),true);return f.db.prepare(sql);},async batch(){assert.fail('admission cannot write');}};
  const changes=f.sqlite.prepare('SELECT total_changes() n').get()!.n,snapshot=await readMutationAdmission(observed,owner,id);assert.equal(queries,1);assert.deepEqual(snapshot.epoch,await checkMutationEpoch(f.db,owner,id));assert.deepEqual(snapshot.receipt,{command_hash:hash,revision:2});assert.equal(snapshot.currentRevision,5);assert.deepEqual(decision(snapshot),{status:'replayed',receipt:{command_hash:hash,revision:2}});assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,changes);
 }finally{f.sqlite.close();}
});
test('retired epoch rejects before matching receipt or mismatched hash and stale editor revision',async()=>{
 const f=await fixture();try{issue(f,owner,'retired');receipt(f);const snapshot=await readMutationAdmission(f.db,owner,id);assert.deepEqual(snapshot.epoch,await checkMutationEpoch(f.db,owner,id));assert.deepEqual(decision(snapshot),{status:'retired',epoch});assert.deepEqual(classifyMutationAdmission(snapshot,{commandHash:'e'.repeat(64),legacyHash:'f'.repeat(64),expectedRevision:99}),{status:'retired',epoch});}finally{f.sqlite.close();}
});
test('reserved malformed IDs fail before SQL; unknown m1 epochs and cross-owner epoch claims retain original errors',async()=>{
 const f=await fixture();try{
  let queries=0;const observed:SqlDatabase={...f.db,prepare(sql){queries++;return f.db.prepare(sql);}};
  for(const invalid of ['short','m1_'+'a'.repeat(60),'m1_'+'A'.repeat(32)+'_'+'d'.repeat(32)])await assert.rejects(readMutationAdmission(observed,owner,invalid),error=>error instanceof MutationEpochError&&error.code==='invalid-id');assert.equal(queries,0);
  issue(f,foreign);receipt(f,owner);
  await assert.rejects(readMutationAdmission(f.db,owner,id),error=>error instanceof MutationEpochError&&error.code==='unknown-epoch');
  const other=await readMutationAdmission(f.db,foreign,id);assert.deepEqual(other.epoch,{status:'active',epoch});assert.equal(other.receipt,null);assert.equal(other.currentRevision,1);
 }finally{f.sqlite.close();}
});
test('legacy and versioned receipt hashes replay exactly while a reused ID rejects before stale conflict',async()=>{
 const f=await fixture();try{
  const legacyId='legacy-admission-0001';receipt(f,owner,legacyId,legacyHash,7);f.sqlite.prepare('UPDATE workspaces SET revision=9 WHERE user_id=?').run(owner);
  const snapshot=await readMutationAdmission(f.db,owner,legacyId);assert.deepEqual(snapshot.epoch,{status:'legacy'});assert.deepEqual(decision(snapshot),{status:'replayed',receipt:{command_hash:legacyHash,revision:7}});
  assert.throws(()=>classifyMutationAdmission(snapshot,{commandHash:'e'.repeat(64),legacyHash:'f'.repeat(64),expectedRevision:1}),MutationIdReuseError);
  const missing=await readMutationAdmission(f.db,owner,'legacy-admission-0002');assert.deepEqual(decision(missing),{status:'conflict',currentRevision:9});assert.deepEqual(decision(missing,9),{status:'prepare'});
  const foreignSnapshot=await readMutationAdmission(f.db,foreign,legacyId);assert.equal(foreignSnapshot.receipt,null);assert.equal(foreignSnapshot.currentRevision,1);
 }finally{f.sqlite.close();}
});
test('missing owner workspace never seeds data or borrows foreign content and epoch rejection still takes precedence',async()=>{
 const f=await fixture();try{
  const missing='never-initialized-owner',legacyId='legacy-missing-0001',before=Number(f.sqlite.prepare('SELECT total_changes() n').get()!.n);
  await assert.rejects(readMutationAdmission(f.db,'',legacyId),/signed-in user/);
  const snapshot=await readMutationAdmission(f.db,missing,legacyId);assert.deepEqual(snapshot,{epoch:{status:'legacy'},receipt:null,currentRevision:null});assert.deepEqual(decision(snapshot),{status:'prepare'});await assert.rejects(readCurrent(f.db,missing),/could not be loaded/);
  await assert.rejects(readMutationAdmission(f.db,missing,id),error=>error instanceof MutationEpochError&&error.code==='unknown-epoch');
  issue(f,missing,'retired');const retired=await readMutationAdmission(f.db,missing,id);assert.deepEqual(decision(retired),{status:'retired',epoch});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspaces WHERE user_id=?').get(missing)!.n,0);assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,before+1,'only the explicit synthetic epoch fixture inserted a row');
 }finally{f.sqlite.close();}
});

test('public executor stale preflight is one read; replay and error precedence remain authoritative',async()=>{
 const f=await fixture();try{
  issue(f);f.sqlite.prepare('UPDATE workspaces SET revision=5 WHERE user_id=?').run(owner);
  const command={type:'fixture.admission'},input={protocolVersion:1,expectedRevision:1,mutationId:id,command};let queries=0;
  const counted:SqlDatabase={prepare(sql){queries++;return f.db.prepare(sql);},batch:statements=>f.db.batch(statements)};
  const deps={db:counted,now:()=>now,handlers:new Map() as CommandHandlerRegistry};
  assert.deepEqual(await executeWorkspaceCommand(owner,input,deps),{status:'conflict',currentRevision:5});assert.equal(queries,1,'stale preflight must not fetch planning or receipt separately');
  const commandHash=await hashJson({protocolVersion:1,command});receipt(f,owner,id,commandHash,2);
  queries=0;const replay=await executeWorkspaceCommand(owner,input,deps);assert.equal(replay.status,'replayed');if(replay.status==='replayed'){assert.equal(replay.receipt.appliedRevision,2);assert.equal(replay.envelope.revision,5);}
  assert.ok(queries>=2,'replay still hydrates the current owner workspace');
  await assert.rejects(executeWorkspaceCommand(owner,{...input,command:{type:'fixture.other'}},deps),MutationIdReuseError);
  f.sqlite.prepare("UPDATE workspace_mutation_epochs SET status='retired' WHERE user_id=?").run(owner);
  await assert.rejects(executeWorkspaceCommand(owner,{...input,command:{type:'fixture.other'}},deps),RetiredMutationError);
  const missing='public-missing-owner';await assert.rejects(executeWorkspaceCommand(missing,{...input,mutationId:'legacy-missing-public'},deps),/workspace could not be loaded/);
 }finally{f.sqlite.close();}
});
test('public executor commit remains exactly once and an epoch retired after preflight aborts atomically',async()=>{
 for(const retire of [false,true]){
  const f=await fixture();try{
   issue(f);let prepared=0,fired=false;const statements=new WeakMap<object,string>();
   const db:SqlDatabase={prepare(sql){const statement=f.db.prepare(sql);statements.set(statement,sql);return statement;},async batch(batch){
    if(retire&&!fired&&batch.some(statement=>statements.get(statement)?.startsWith('INSERT INTO workspace_command_guards'))){fired=true;f.sqlite.prepare("UPDATE workspace_mutation_epochs SET status='retired' WHERE user_id=?").run(owner);}
    return f.db.batch(batch);
   }};
   const handlers:CommandHandlerRegistry=new Map([['fixture.admission',{prepare:async context=>{
    prepared++;const planningAfter=structuredClone(context.before.workspace);planningAfter.projects[0].goal='Reviewed admission change';
    return {planningAfter,writes:[],events:[{id:'admission-native-event',kind:'fixture.admission',entityType:'project',entityId:planningAfter.projects[0].id,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}],jobs:[]};
   }}]]),input={protocolVersion:1,expectedRevision:1,mutationId:id,command:{type:'fixture.admission'}},deps={db,handlers,now:()=>now};
   if(retire){await assert.rejects(executeWorkspaceCommand(owner,input,deps),RetiredMutationError);assert.equal(fired,true);assert.equal((await readCurrent(f.db,owner,now)).revision,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').get(owner)!.n,0);}
   else{assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'committed');assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'replayed');assert.equal(prepared,1);assert.equal((await readCurrent(f.db,owner,now)).revision,2);assert.equal((await readCurrent(f.db,foreign,now)).revision,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,1);}
  }finally{f.sqlite.close();}
 }
});

test('post-batch retired epoch wins over an actual receipt; a lost response replays exactly once',async()=>{
 for(const mode of ['normal','retire-after-commit','lost-response'] as const){
  const f=await fixture();try{
   issue(f);let fired=false,prepared=0,coqueries=0,separateReceipts=0;const sqls=new WeakMap<object,string>();
   const db:SqlDatabase={prepare(sql){if(sql.startsWith('SELECT e.status epoch_status'))coqueries++;if(sql.startsWith('SELECT command_hash, revision FROM workspace_mutations'))separateReceipts++;const statement=f.db.prepare(sql);sqls.set(statement,sql);return statement;},async batch(batch){
    const result=await f.db.batch(batch);
    if(!fired&&batch.some(statement=>sqls.get(statement)?.startsWith('INSERT INTO workspace_command_guards'))){
     fired=true;if(mode==='retire-after-commit')f.sqlite.prepare("UPDATE workspace_mutation_epochs SET status='retired' WHERE user_id=?").run(owner);
     if(mode==='lost-response')throw new Error('Synthetic response lost after actual commit.');
    }
    return result;
   }};
   const handlers:CommandHandlerRegistry=new Map([['fixture.admission',{prepare:async context=>{prepared++;return {planningAfter:context.before.workspace,writes:[],events:[],jobs:[]};}}]]),input={protocolVersion:1,expectedRevision:1,mutationId:id,command:{type:'fixture.admission'}},deps={db,handlers,now:()=>now};
   if(mode==='retire-after-commit'){await assert.rejects(executeWorkspaceCommand(owner,input,deps),RetiredMutationError);assert.equal(coqueries,2,'initial and final epoch/receipt read use coqueries');await assert.rejects(executeWorkspaceCommand(owner,input,deps),RetiredMutationError);}
   else{const result=await executeWorkspaceCommand(owner,input,deps);assert.equal(result.status,mode==='normal'?'committed':'replayed');if(mode==='normal'){assert.equal(coqueries,2);assert.equal(separateReceipts,0,'successful tail must not read receipts separately');}assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'replayed');}
   assert.equal(fired,true);assert.equal(prepared,1);assert.equal((await readCurrent(f.db,owner,now)).revision,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,1);
  }finally{f.sqlite.close();}
 }
});
