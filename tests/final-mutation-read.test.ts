import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {readMutationAdmission} from '../lib/mutation-admission-reader.ts';
import {readFinalMutation} from '../lib/final-mutation-read.ts';
const owner='synthetic-final-cohort',now='2026-10-18T12:00:00.000Z',id='synthetic_final_mutation';
async function parity(db:SqlDatabase,baseline:boolean){
 await loadWorkspace(db,owner,baseline?()=>createSeedWorkspace(now):workspaceFixture,now);
 const expected=await readCurrent(db,owner,now),admission=await readMutationAdmission(db,owner,id),batches:number[]=[],queries:string[]=[];
 const observed:SqlDatabase={prepare(sql){queries.push(sql);return db.prepare(sql);},batch(statements){batches.push(statements.length);return db.batch(statements);}};
 const result=await readFinalMutation(observed,owner,id,now);
 assert.deepEqual(result.admission,admission);assert.deepEqual(result.readCurrent(),expected);
 assert.deepEqual(batches,baseline?[2,1]:[2]);assert.ok(queries[0].startsWith('SELECT e.status epoch_status,'));assert.ok(queries[1].startsWith('SELECT w.content,w.revision,w.updated_at,'));
 if(baseline)assert.ok(queries[2].startsWith('SELECT DISTINCT entity_id FROM audit_events '));
}
test('final read shares two original owner SELECTs and retains dependent baseline hydration',async()=>{for(const baseline of [false,true]){const f=database();try{await parity(f.db,baseline);}finally{f.sqlite.close();}}});
test('current decoding failure is drained and deferred while admission decoding failure has priority',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);f.sqlite.prepare('UPDATE workspaces SET content=? WHERE user_id=?').run('{bad',owner);
  const result=await readFinalMutation(f.db,owner,id,now);assert.equal(result.admission.epoch.status,'legacy');assert.throws(()=>result.readCurrent());
  let calls=0;const observed:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){calls++;const rows=await f.db.batch(statements);rows[0].results=[];return rows;}};
  await assert.rejects(readFinalMutation(observed,owner,id,now),/Mutation admission snapshot could not be read/);assert.equal(calls,1);
 }finally{f.sqlite.close();}
});
test('malformed closed batch certificates fail closed without retry or dropped rejection',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);
  for(const mode of ['missing','extra','rows','primitive','throw']){
   let calls=0;const observed:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){calls++;if(mode==='throw')throw new Error('native batch failed');const rows=await f.db.batch(statements);if(mode==='missing')rows.pop();if(mode==='extra')rows.push(rows[0]);if(mode==='rows')rows[0].results=[{},{}];if(mode==='primitive')rows[0].results=[null];return rows;}};
   await assert.rejects(readFinalMutation(observed,owner,id,now),mode==='throw'?/native batch failed/:/Invalid final mutation/);assert.equal(calls,1);
  }
 }finally{f.sqlite.close();}
});
test('native D1 preserves exact hydration with one initial two-statement batch',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readdir,readFile}=await import('node:fs/promises');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic final cohort")}}',d1Databases:{DB:'synthetic-final-cohort'}});
 try{const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort())for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();await parity(db,true);}finally{await mf.dispose();}
});
test('executor final retirement and reused hash precede corrupt hydration; missing receipt still reads current',async()=>{
 const {executeWorkspaceCommand}=await import('../lib/workspace-transaction.ts'),{workspaceHandlers}=await import('../lib/workspace-handlers.ts'),{issueMutationId}=await import('../lib/idempotency-retention.ts');
 for(const mode of ['normal','retired','hash','missing']){
  const f=database();try{
   await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);const before=await readCurrent(f.db,owner,now),mutationId=await issueMutationId(f.db,owner,now);
   let finalBatches=0;const observed:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){const rows=await f.db.batch(statements);if(rows.length===2&&rows[0].results?.[0]&&Object.hasOwn(rows[0].results[0] as object,'epoch_status')){finalBatches++;const admission=rows[0].results[0] as Record<string,unknown>,current=rows[1].results![0] as Record<string,unknown>;if(mode!=='normal')current.content='{broken';if(mode==='retired')admission.epoch_status='retired';if(mode==='hash')admission.receipt_hash='different';if(mode==='missing')admission.receipt_id=null;}return rows;}};
   const input={protocolVersion:1,expectedRevision:before.revision,mutationId,command:{type:'capture.update',id:before.workspace.captures[0].id,patch:{body:'Synthetic final cohort update'}}},deps={db:observed,handlers:workspaceHandlers,now:()=>now};
   if(mode==='normal'){assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'committed');assert.equal((await executeWorkspaceCommand(owner,input,deps)).status,'replayed');}
   else await assert.rejects(executeWorkspaceCommand(owner,input,deps),mode==='retired'?/epoch is retired/:mode==='hash'?/reused for a different change/:/JSON|workspace|Unexpected|valid/i);
   assert.equal(finalBatches,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,1);
  }finally{f.sqlite.close();}
 }
});
