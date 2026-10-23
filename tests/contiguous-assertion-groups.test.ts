import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
import {privateCapacityGuard} from '../lib/private-capacity.ts';
import {capturePrivateSchema} from '../lib/private-schema.ts';
import {combineClaimConditions,recoverabilityConditions,prepareClaimAssertions,type RecoverabilityCondition} from '../lib/recoverability-admission.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
import {OWNER_TABLES} from '../lib/workspace-modules.ts';
const owner='synthetic-contiguous-assertions',now='2026-10-18T12:00:00.000Z',id='assertion-mutation',guard=[owner,id,'token'];
const claim='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?)';
function combine(conditions:RecoverabilityCondition[]){return combineClaimConditions(owner,id,claim,guard,conditions);}
test('balanced combination preserves every ordered predicate and typed binding, including duplicate guards',()=>{
 const conditions=Array.from({length:41},(_,index)=>({sql:`?=${index} /* predicate-${index} */`,bindings:[index]}));
 const [group]=combine(conditions);assert.equal(combine(conditions).length,1);assert.deepEqual(group.bindings,conditions.flatMap(condition=>condition.bindings));
 let last=-1;for(let index=0;index<41;index++){const position=group.sql.indexOf(`/* predicate-${index} */`);assert.ok(position>last);last=position;}
 const duplicate={sql:'? IS ? /* schema-guard */',bindings:['same','same']};const [repeated]=combine([duplicate,duplicate]);assert.equal((repeated.sql.match(/schema-guard/gu)??[]).length,2);assert.deepEqual(repeated.bindings,['same','same','same','same']);
 assert.deepEqual(combine([]),[]);assert.deepEqual(combine([conditions[0]]),[conditions[0]]);
});
test('combined native parameter, escaped UTF8 framing and SQL bounds fall back to original singletons before any DB call',()=>{
 const atLimit=Array.from({length:95},()=>({sql:'?=1',bindings:[1]}));assert.equal(combine(atLimit).length,1);assert.deepEqual(combine([...atLimit,{sql:'?=1',bindings:[1]}]),[...atLimit,{sql:'?=1',bindings:[1]}]);
 const below=[{sql:'? IS NOT NULL',bindings:['ع'.repeat(449000)]},{sql:'? IS NOT NULL',bindings:['ع'.repeat(449000)]}];assert.equal(combine(below).length,1);
 const above=[{sql:'? IS NOT NULL',bindings:['ع'.repeat(450000)]},{sql:'? IS NOT NULL',bindings:['ع'.repeat(450000)]}];assert.deepEqual(combine(above),above);
 const sqlBound=[{sql:'1 /*'+'x'.repeat(60000)+'*/',bindings:[]},{sql:'1 /*'+'x'.repeat(60000)+'*/',bindings:[]}];assert.deepEqual(combine(sqlBound),sqlBound);
});
async function preflight(db:SqlDatabase){
 await loadWorkspace(db,owner,()=>createSeedWorkspace(now),now);const before=await readCurrent(db,owner,now),quote=await measureProspectiveRecoverability(db,owner,{now,planningAfter:before.workspace});
 const metadata=await capturePrivateSchema(db),capacity=await privateCapacityGuard(db,owner,{schemaContext:metadata}),checks=recoverabilityConditions(owner,id,quote,guard);
 const prefix=[capacity,{sql:metadata.guard.sql,bindings:[...metadata.guard.bindings]},checks[0]],rows=checks.slice(1,-1),suffix=[checks.at(-1)!,{sql:'(SELECT COUNT(*) FROM workspace_mutations WHERE user_id=?) < ?',bindings:[owner,100000]}];
 return {before,prefix,rows,suffix};
}
test('all real prewrite predicates remain ordered while twelve-table row groups and the two-table tail stay exact',async()=>{
 const f=database();try{
  const {prefix,rows,suffix}=await preflight(f.db);assert.equal(prefix.length,3);assert.equal(rows.length,4);assert.equal(suffix.length,2);
  assert.equal(OWNER_TABLES.length,38);
  assert.deepEqual(rows.map(condition=>(condition.sql.match(/ EXCEPT /gu)??[]).length),[12,12,12,2]);
  const rowSql=rows.map(condition=>condition.sql).join('\n');let lastTable=-1;
  for(const table of OWNER_TABLES){const positions=[...rowSql.matchAll(new RegExp(`FROM ${table} WHERE`,'gu'))].map(match=>match.index);assert.equal(positions.length,2,`count and exact-set predicates for ${table}`);assert.ok(positions[0]>lastTable,`ordered row predicate for ${table}`);lastTable=positions[1];}
  const grouped=[...combine(prefix),...rows,...combine(suffix)];assert.equal(grouped.length,6);assert.deepEqual(grouped.map(condition=>2+condition.bindings.length+guard.length),[35,53,53,53,13,11]);
  assert.deepEqual(grouped.flatMap(condition=>condition.bindings),[...prefix,...rows,...suffix].flatMap(condition=>condition.bindings));
  for(const group of grouped){assert.ok(2+group.bindings.length+guard.length<=100);assert.ok(new TextEncoder().encode(JSON.stringify([owner,id,...group.bindings,...guard])).length<=1800000);}
  const schemaSql=prefix[1].sql;assert.equal(grouped[0].sql.split(schemaSql).length-1,2);assert.ok(grouped[0].sql.includes(prefix[0].sql));assert.ok(grouped[0].sql.indexOf(prefix[0].sql)<grouped[0].sql.indexOf(prefix[2].sql));
 }finally{f.sqlite.close();}
});
test('committed capture update keeps prewrite groups before the receipt DML, postwrite checks after the workspace update, replay and stale outcomes',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);const before=await readCurrent(f.db,owner,now),mutationId=await issueMutationId(f.db,owner,now),command={type:'capture.update',id:before.workspace.captures[0].id,patch:{body:'Only an explicit owner command changes this.'}};
  const native=new WeakMap<SqlStatement,{statement:SqlStatement;sql:string}>();let atomicSql:string[]=[];
  const observed:SqlDatabase={prepare(sql){let statement=f.db.prepare(sql);const wrapped:SqlStatement={bind(...values){statement=statement.bind(...values);native.set(wrapped,{statement,sql});return wrapped;},first:()=>statement.first(),all:()=>statement.all(),run:()=>statement.run()};native.set(wrapped,{statement,sql});return wrapped;},async batch(statements){const selected=statements.map(statement=>native.get(statement)!);if(selected[0].sql.startsWith('INSERT INTO workspace_command_guards'))atomicSql=selected.map(item=>item.sql);return f.db.batch(selected.map(item=>item.statement));}};
  const input={protocolVersion:1,expectedRevision:before.revision,mutationId,command},deps={db:observed,handlers:workspaceHandlers,now:()=>now};
  assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'committed');
  const receipt=atomicSql.findIndex(sql=>sql.startsWith('INSERT INTO workspace_mutations'));assert.equal(receipt,7);assert.equal(atomicSql.length,14);assert.ok(atomicSql.slice(1,receipt).every(sql=>sql.startsWith('INSERT INTO workspace_assertions')));
  const update=atomicSql.findIndex(sql=>sql.startsWith('UPDATE workspaces SET'));assert.ok(update>receipt);assert.match(atomicSql[update+1],/CASE WHEN EXISTS \(SELECT 1 FROM workspaces/);
  assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'replayed');assert.equal((await executeWorkspaceCommand(owner,{...input,mutationId:await issueMutationId(f.db,owner,now)},deps)).status,'conflict');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_assertions').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_command_guards').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('actual D1 accepts combined real prefix and suffix without changing native row groups, and a false assertion rolls back the whole batch',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readdir,readFile}=await import('node:fs/promises');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic assertion proof")}}',d1Databases:{DB:'synthetic-assertion-proof'}});
 try{
  const nativeDb=await mf.getD1Database('DB'),db:SqlDatabase=nativeDb,files=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
  for(const name of files)for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
  const {prefix,rows,suffix}=await preflight(db);await db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...guard).run();
  const grouped=[...combine(prefix),...rows,...combine(suffix)];assert.equal(grouped.length,6);assert.deepEqual(grouped.map(condition=>2+condition.bindings.length+guard.length),[35,53,53,53,13,11]);
  await db.batch(prepareClaimAssertions(db,owner,id,claim,guard,grouped));assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_assertions').first<{n:number}>())!.n,6);
  await db.prepare('DELETE FROM workspace_assertions').run();
  const deniedCapacity=await privateCapacityGuard(db,owner,{growth:[{table:'workspace_mutations',bytes:100000000,rows:0}]});
  const denyBound=(condition:RecoverabilityCondition,index:number,value:number)=>({...condition,bindings:condition.bindings.map((binding,position)=>position===index?value:binding)});
  const rejectedLeaves=[deniedCapacity,denyBound(prefix[1],1,-1),denyBound(prefix[2],1,999),denyBound(suffix[0],1,1),denyBound(suffix[1],1,0)];
  for(let rejected=0;rejected<rejectedLeaves.length;rejected++){
   const changedPrefix=prefix.map((condition,index)=>index===rejected?rejectedLeaves[rejected]:condition),changedSuffix=suffix.map((condition,index)=>prefix.length+index===rejected?rejectedLeaves[rejected]:condition);
   await assert.rejects(db.batch(prepareClaimAssertions(db,owner,id,claim,guard,[...combine(changedPrefix),...rows,...combine(changedSuffix)])),/assertion_valid|CHECK constraint failed/);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_assertions').first<{n:number}>())!.n,0);
  }
  const invalid=[...grouped,{sql:'0',bindings:[]}];await assert.rejects(db.batch(prepareClaimAssertions(db,owner,id,claim,guard,invalid)),/assertion_valid|CHECK constraint failed/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_assertions').first<{n:number}>())!.n,0);assert.equal((await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,1);
  // A missing claim never admits even true predicates.
  await db.prepare('DELETE FROM workspace_command_guards').run();await db.batch(prepareClaimAssertions(db,owner,id,claim,guard,grouped));assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_assertions').first<{n:number}>())!.n,0);
  // Exercise the actual production quote, duplicate schema guard, compiler,
  // storage writes, epoch receipt and post-write reconciliation on real D1.
  const before=await readCurrent(db,owner,now),mutationId=await issueMutationId(db,owner,now),input={protocolVersion:1,expectedRevision:before.revision,mutationId,command:{type:'capture.update',id:before.workspace.captures[0].id,patch:{body:'Native owner-authorized capture correction'}}},deps={db,handlers:workspaceHandlers,now:()=>now};
  assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'committed');assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'replayed');assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_mutations').first<{n:number}>())!.n,1);

 }finally{await mf.dispose();}
});

