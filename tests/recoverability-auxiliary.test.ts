import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,taskFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {readRecoverabilityAuxiliary} from '../lib/recoverability-auxiliary.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {getProjectBaseline,baselineRecordId} from '../lib/project-baselines.ts';
import {createWeeklyPlan} from '../lib/weekly-planning.ts';
import {currentWeek} from '../lib/calendar.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-auxiliary-owner';
function observe(db:SqlDatabase){
 const queries=new WeakMap<SqlStatement,string>(),batches:string[][]=[];
 const observed:SqlDatabase={prepare(sql){const native=db.prepare(sql);queries.set(native,sql);return native;},async batch(statements){batches.push(statements.map(statement=>queries.get(statement)??''));return db.batch(statements);}};
 return {db:observed,batches};
}
test('closed auxiliary readers co-batch independent SELECTs with exact existing decoder parity and owner isolation',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,()=>workspaceFixture({tasks:[taskFixture('original-task')]}),now);await loadWorkspace(f.db,'foreign-owner',workspaceFixture,now);
  f.sqlite.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)").run(owner,'reviews',7);
  f.sqlite.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)").run('foreign-owner','reviews',99);
  const expected={current:await readCurrent(f.db,owner,now),namespaces:await getWorkspaceNamespaces(f.db,owner),watermarks:await readOperationalWatermarks(f.db,owner),terminalReserveRows:[]};
  const seen=observe(f.db),actual=await readRecoverabilityAuxiliary(seen.db,owner,now,{includeTerminalReserve:true});
  assert.deepEqual(actual,expected);assert.deepEqual(seen.batches.map(rows=>rows.length),[4]);assert.ok(seen.batches.flat().every(sql=>sql.startsWith('SELECT ')||sql.startsWith('WITH watermark_owner ')));assert.equal(actual.watermarks.reviews,7);
  f.sqlite.prepare("UPDATE operational_stream_heads SET last_sequence=8 WHERE user_id=? AND stream_id='reviews'").run(owner);
  const again=await readRecoverabilityAuxiliary(seen.db,owner,now,{includeNamespaces:false});assert.equal(again.watermarks.reviews,8);assert.equal(again.namespaces,null);assert.deepEqual(seen.batches.map(rows=>rows.length),[4,2]);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('dependent baseline removal reads and current weekly hydration retain original IDs and clocks',async()=>{
 const f=database();try{
  const seeded=createSeedWorkspace(now);seeded.tasks.push(taskFixture('synthetic-explicit-weekly-task',{projectId:seeded.projects[0].id,status:'todo'}));
  await loadWorkspace(f.db,owner,()=>seeded,now);
  const workspace=(await readCurrent(f.db,owner,now)).workspace,project=workspace.projects.find(value=>getProjectBaseline(value));assert.ok(project);
  const removed=baselineRecordId(project.id,'context');f.sqlite.prepare("INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,0,'entity.delete','task',?,?,?)").run(owner,'synthetic-original-removal',removed,now,'{}');
  const task=workspace.tasks.find(value=>value.id==='synthetic-explicit-weekly-task');assert.ok(task);assert.equal(task.status,'todo');const plan={...createWeeklyPlan(currentWeek(now)),taskIds:[task.id]},text=canonical(plan);
  f.sqlite.prepare('INSERT INTO weekly_plans(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(owner,plan.weekStart,text,await contentHash(text));
  const seen=observe(f.db),actual=await readRecoverabilityAuxiliary(seen.db,owner,now),expected=await readCurrent(f.db,owner,now);
  assert.deepEqual(actual.current,expected);assert.deepEqual(actual.current.baselineRemovedIds,[removed]);assert.equal(actual.current.workspace.tasks.find(value=>value.id===task.id)!.weekly,true);assert.equal(actual.current.workspace.tasks.find(value=>value.id===task.id)!.weeklyWeek,plan.weekStart);
  assert.deepEqual(seen.batches.map(rows=>rows.length),[3,1]);assert.match(seen.batches[1][0],/^SELECT DISTINCT entity_id FROM audit_events /u);assert.equal(actual.current.updatedAt,expected.updatedAt);
 }finally{f.sqlite.close();}
});
test('batch failures, malformed results and preparation failures settle without mutations or cached fallback',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);
  for(const mode of ['throw','missing','rows','prepare']as const){
   let batches=0;const db:SqlDatabase={prepare(sql){if(mode==='prepare'&&sql.startsWith('SELECT audit_namespace'))throw new Error('Synthetic auxiliary preparation failure');return f.db.prepare(sql);},async batch(statements){batches++;if(mode==='throw')throw new Error('Synthetic auxiliary read failure');const result=await f.db.batch(statements);if(mode==='missing')return result.slice(1);if(mode==='rows')result[0]={meta:{},results:[null]};return result;}};
   await assert.rejects(readRecoverabilityAuxiliary(db,owner,now,{includeTerminalReserve:true}),mode==='prepare'?/preparation failure/:mode==='throw'?/auxiliary read failure/:/auxiliary snapshot batch/i);
   assert.ok(batches<=1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
  }
  assert.equal((await readRecoverabilityAuxiliary(f.db,owner,now)).current.revision,1);
  const blocked:SqlDatabase={prepare(){throw new Error('Invalid input reached SQL');},async batch(){throw new Error('Invalid input reached SQL');}};
  await assert.rejects(readRecoverabilityAuxiliary(blocked,'',now),/owner/);await assert.rejects(readRecoverabilityAuxiliary(blocked,owner,'unknown'),/timestamp/);
 }finally{f.sqlite.close();}
});
test('actual Miniflare D1 batches native immutable bound SELECTs without losing owner bindings or result metadata',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readFile,readdir}=await import('node:fs/promises'),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic auxiliary reads")}}',d1Databases:{DB:'synthetic-auxiliary-recovery'}});
 try{
  const db=await mf.getD1Database('DB'),files=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
  for(const name of files)for(const sql of(await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
  await loadWorkspace(db,owner,workspaceFixture,now);await loadWorkspace(db,'foreign-owner',workspaceFixture,now);
  await db.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)").bind(owner,'reviews',12).run();await db.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)").bind('foreign-owner','reviews',88).run();
  const actual=await readRecoverabilityAuxiliary(db,owner,now,{includeTerminalReserve:true});assert.equal(actual.current.revision,1);assert.equal(actual.watermarks.reviews,12);assert.deepEqual(actual.current,await readCurrent(db,owner,now));assert.deepEqual(actual.namespaces,await getWorkspaceNamespaces(db,owner));assert.deepEqual(actual.terminalReserveRows,[]);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_mutations').first<{n:number}>())!.n,0);
 }finally{await mf.dispose();}
});
