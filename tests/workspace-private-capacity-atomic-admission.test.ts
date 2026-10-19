import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand,type CommandHandlerRegistry} from '../lib/workspace-transaction.ts';
import {PRIVATE_PROFILE_TABLES} from '../lib/private-profile.ts';
import {canonical} from '../lib/canonical-json.ts';
import {PrivateCapacityError,PRIVATE_REVOCATION_POOL} from '../lib/private-capacity.ts';
import {WorkspaceCapacityError,RECEIPT_CAPACITY} from '../lib/workspace-capacity.ts';
import {MutationIdReuseError,WorkspaceStorageError} from '../lib/workspace-errors.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-atomic-private-owner',expires='2026-10-19T12:00:00.000Z';
const limit=64*1024*1024-PRIVATE_REVOCATION_POOL.bytes-PRIVATE_REVOCATION_POOL.framingBytes;
const command={type:'fixture.atomic.private',value:'Explicit owner change'};
const input=(mutationId=crypto.randomUUID(),expectedRevision=1)=>({protocolVersion:1,mutationId,expectedRevision,command});
const handlers:CommandHandlerRegistry=new Map([[command.type,{async prepare(context){
 const planningAfter=structuredClone(context.before.workspace);planningAfter.projects[0].goal='Explicit owner change';
 return {planningAfter,writes:[],jobs:[],events:[{id:crypto.randomUUID(),kind:'fixture.atomic.private',entityType:'project',entityId:planningAfter.projects[0].id,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}]};
}}]]);
async function fixture(){const f=database();await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);return f;}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function physicalBytes(f:Fixture){
 let bytes=0;
 for(const table of PRIVATE_PROFILE_TABLES){
  const columns=f.sqlite.prepare('PRAGMA table_info('+table+')').all().map(row=>String(row.name)).filter(name=>name!=='user_id').sort();
  const json='json_object('+columns.flatMap(name=>["'"+name+"'",'"'+name+'"']).join(',')+')';
  bytes+=Number(f.sqlite.prepare('SELECT COALESCE(SUM(length(CAST('+json+' AS BLOB))+1),0) n FROM '+table+' WHERE user_id=?').get(owner)!.n);
 }
 // This fixture has no delete events, so the separately charged baseline fences are empty.
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE user_id=? AND kind='entity.delete'").get(owner)!.n,0);
 return bytes;
}
function fill(f:Fixture,target=limit){
 const remaining=target-physicalBytes(f),max=1_700_000,example={id:'capacity-fill-000',row_revision:1,payload_json:'',expires_at:expires};
 const overhead=new TextEncoder().encode(canonical(example)).length+1,count=Math.ceil(remaining/(max+overhead));assert.ok(count>0&&count<100);
 let payload=remaining-count*overhead;
 for(let index=0;index<count;index++){
  const length=Math.min(max,payload);payload-=length;
  f.sqlite.prepare("INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,replace(hex(zeroblob(?)),'00','x'),?)").run(owner,'capacity-fill-'+String(index).padStart(3,'0'),length,expires);
 }
 assert.equal(payload,0);assert.equal(physicalBytes(f),target);
}
function effects(f:Fixture){
 return ['workspaces','audit_events','workspace_job_intents','workspace_mutations','workspace_command_guards','workspace_assertions'].map(table=>f.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=? ORDER BY 1,2').all(owner));
}
function instrument(f:Fixture,beforeMutation?:()=>void){
 const sqls=new WeakMap<SqlStatement,string>(),originals=new WeakMap<SqlStatement,SqlStatement>();let mutationBatches=0,capacityReads=0;
 const db:SqlDatabase={prepare(sql){
  const statement=f.db.prepare(sql),wrapped:SqlStatement={bind(...values){statement.bind(...values);return this;},async first<T>(){if(sql.startsWith('SELECT 1 WHERE ')&&sql.includes('private_capacity_owner AS MATERIALIZED'))capacityReads++;return statement.first<T>();},all<T>(){return statement.all<T>();},run(){return statement.run();}};
  sqls.set(wrapped,sql);originals.set(wrapped,statement);return wrapped;
 },async batch(statements){
  const actual=statements.some(statement=>sqls.get(statement)?.startsWith('INSERT INTO workspace_command_guards'));
  if(actual){mutationBatches++;assert.equal(mutationBatches,1);beforeMutation?.();}
  // The original adapter owns its statements; unwrap without altering SQL/results.
  return f.db.batch(statements.map(statement=>originals.get(statement)??statement));
 }};
 return {db,get mutationBatches(){return mutationBatches;},get capacityReads(){return capacityReads;}};
}
const deps=(db:SqlDatabase)=>({db,handlers,now:()=>now});
test('full private quota is refused by the actual atomic batch with a typed error and no partial owner effects',async()=>{
 const f=await fixture();try{
  fill(f);const before=effects(f),probe=instrument(f),request=input();
  await assert.rejects(executeWorkspaceCommand(owner,request,deps(probe.db)),PrivateCapacityError);
  assert.equal(probe.mutationBatches,1,'the CHECK, rather than a duplicate SELECT preflight, must reject growth');
  assert.equal(probe.capacityReads,1,'only failure classification evaluates a standalone capacity SELECT');
  assert.deepEqual(effects(f),before);assert.equal(physicalBytes(f),limit);
 }finally{f.sqlite.close();}
});
test('independent private growth immediately before the mutation batch rolls back every intended effect',async()=>{
 const f=await fixture();try{
  fill(f,limit-4096);const before=effects(f);
  const probe=instrument(f,()=>{f.sqlite.prepare('UPDATE workspace_drafts SET payload_json=payload_json||? WHERE user_id=? AND id=?').run('x'.repeat(4096),owner,'capacity-fill-000');});
  await assert.rejects(executeWorkspaceCommand(owner,input(),deps(probe.db)),PrivateCapacityError);
  assert.equal(probe.mutationBatches,1);assert.equal(probe.capacityReads,1);assert.deepEqual(effects(f),before);
  assert.equal(physicalBytes(f),limit,'independent pressure remains; the attempted receipt, event and planning edit do not');
 }finally{f.sqlite.close();}
});
test('healthy success performs no capacity preflight; exact replay and mutation identity retain precedence at full quota',async()=>{
 const f=await fixture();try{
  const request=input(),first=instrument(f);assert.equal((await executeWorkspaceCommand(owner,request,deps(first.db))).status,'committed');
  assert.equal(first.mutationBatches,1);assert.equal(first.capacityReads,0);
  fill(f);const before=effects(f),replay=instrument(f),result=await executeWorkspaceCommand(owner,request,deps(replay.db));
  assert.equal(result.status,'replayed');assert.equal(result.receipt.appliedRevision,2);assert.equal(replay.mutationBatches,0);assert.equal(replay.capacityReads,0);
  await assert.rejects(executeWorkspaceCommand(owner,{...request,command:{...command,value:'Different owner change'}},deps(replay.db)),MutationIdReuseError);
  assert.deepEqual(effects(f),before);
 }finally{f.sqlite.close();}
});
test('a revision change at the actual mutation boundary wins over full private capacity without writing a receipt',async()=>{
 const f=await fixture();try{
  fill(f);const before=effects(f),probe=instrument(f,()=>{f.sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run(owner);});
  assert.deepEqual(await executeWorkspaceCommand(owner,input(),deps(probe.db)),{status:'conflict',currentRevision:2});
  assert.equal(probe.mutationBatches,1);assert.equal(probe.capacityReads,0);
  const after=effects(f);assert.deepEqual(after.slice(1),before.slice(1));assert.equal((await readCurrent(f.db,owner,now)).revision,2);
  assert.equal((await readCurrent(f.db,owner,now)).workspace.projects[0].goal,'');
 }finally{f.sqlite.close();}
});
test('late receipt exhaustion is classified ahead of private capacity and preserves all independently added receipts',async()=>{
 const f=await fixture();try{
  const count=RECEIPT_CAPACITY.hard-PRIVATE_REVOCATION_POOL.rows-1;
  f.sqlite.prepare("WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) SELECT ?,printf('synthetic-receipt-%06d',i),?,1,? FROM n").run(count,owner,'a'.repeat(64),now);
  fill(f);const before=effects(f),probe=instrument(f,()=>{
   const insert=f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)');
   for(let index=0;index<=PRIVATE_REVOCATION_POOL.rows;index++)insert.run(owner,'independent-late-'+index,'b'.repeat(64),1,now);
  });
  await assert.rejects(executeWorkspaceCommand(owner,input(),deps(probe.db)),WorkspaceCapacityError);
  assert.equal(probe.mutationBatches,1);assert.equal(probe.capacityReads,0);
  const after=effects(f);for(const index of [0,1,2,4,5])assert.deepEqual(after[index],before[index]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,RECEIPT_CAPACITY.hard);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=? AND mutation_id LIKE 'independent-late-%'").get(owner)!.n,21);
 }finally{f.sqlite.close();}
});
test('an unconfirmed storage failure with a fitting guard stays uncertain, never a fabricated capacity refusal',async()=>{
 const f=await fixture();try{
  const before=effects(f),probe=instrument(f,()=>{throw new Error('synthetic storage outcome unavailable');});
  await assert.rejects(executeWorkspaceCommand(owner,input(),deps(probe.db)),WorkspaceStorageError);
  assert.equal(probe.mutationBatches,1);assert.equal(probe.capacityReads,1);assert.deepEqual(effects(f),before);
 }finally{f.sqlite.close();}
});
