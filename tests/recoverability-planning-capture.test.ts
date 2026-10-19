import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {capturePlanningForRecoverability,capturePlanningPreflight,consumePlanningCapture} from '../lib/recoverability-planning-capture.ts';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-capture-owner';
const scope={now,mutationId:'synthetic_planning_capture_0001',expectedRevision:1};
test('actual owner read is isolated from handler mutation; token is single-use and exact-scope bound',async()=>{
 const f=database(),other=database();try{
 await loadWorkspace(f.db,owner,workspaceFixture,now);
 const {before,capture}=await capturePlanningForRecoverability(f.db,owner,scope),original=structuredClone(before);
 before.workspace.captures.length=0;before.workspace.projects.length=0;
 for(const [db,user,time,value] of [[other.db,owner,now,capture],[f.db,'other-owner',now,capture],[f.db,owner,'2026-10-18T12:01:00.000Z',capture],[f.db,owner,now,{...capture,mutationId:'different_operation'}],[f.db,owner,now,{...capture,expectedRevision:2}],[f.db,owner,now,JSON.parse(JSON.stringify(capture))]] as const)assert.throws(()=>consumePlanningCapture(db,user,time,value),/Invalid or consumed/);
 assert.deepEqual(consumePlanningCapture(f.db,owner,now,capture),original);
 assert.throws(()=>consumePlanningCapture(f.db,owner,now,capture),/Invalid or consumed/);
 }finally{f.sqlite.close();other.sqlite.close();}
});
test('captured and ordinary measurement are exact; final reread still rejects same-revision planning changes',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,owner,workspaceFixture,now);
 const ordinary=await measureProspectiveRecoverability(f.db,owner,{now});
 const first=await capturePlanningForRecoverability(f.db,owner,scope);
 assert.deepEqual(await measureProspectiveRecoverability(f.db,owner,{now,planningCapture:first.capture}),ordinary);
 const second=await capturePlanningForRecoverability(f.db,owner,{...scope,mutationId:'synthetic_planning_capture_0002'});
 const current=await readCurrent(f.db,owner,now);current.workspace.projects[0].name='Changed without revision';
 f.sqlite.prepare('UPDATE workspaces SET content=? WHERE user_id=?').run(JSON.stringify(current.workspace),owner);
 // A stale first envelope must never certify same-revision out-of-band edits.
 await assert.rejects(measureProspectiveRecoverability(f.db,owner,{now,planningCapture:second.capture}),/Workspace boundary changed/);
 }finally{f.sqlite.close();}
});

test('actual Miniflare D1 capture preserves measurement and rejects late same-revision edits',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readdir,readFile}=await import('node:fs/promises');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated planning capture proof")}}',d1Databases:{DB:'synthetic-planning-capture'}});
 try{
 const db=await mf.getD1Database('DB');
 const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
 assert.equal(migrations.length,27,'Native capture proof requires all 27 actual migrations.');
 for(const name of migrations)for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
 await loadWorkspace(db,owner,workspaceFixture,now);
 const ordinary=await measureProspectiveRecoverability(db,owner,{now}),first=await capturePlanningPreflight(db,owner,scope);
 assert.equal(first.readReceiptCount(),0);
 assert.deepEqual(await measureProspectiveRecoverability(db,owner,{now,planningCapture:first.capture}),ordinary);
 const late=await capturePlanningForRecoverability(db,owner,{...scope,mutationId:'synthetic_native_capture_0002'});
 const current=await readCurrent(db,owner,now);current.workspace.projects[0].name='Native same-revision change';
 await db.prepare('UPDATE workspaces SET content=? WHERE user_id=?').bind(JSON.stringify(current.workspace),owner).run();
 await assert.rejects(measureProspectiveRecoverability(db,owner,{now,planningCapture:late.capture}),/Workspace boundary changed/);
 assert.equal((await db.prepare('SELECT COUNT(*) count FROM workspace_mutations').first<{count:number}>())!.count,0);
 }finally{await mf.dispose();}
});

test('the already captured first read is reused, while a fresh final owner read remains mandatory',async()=>{
 const f=database();try{
 let currentReads=0;
 const db:SqlDatabase={prepare(sql){if(sql.startsWith('SELECT w.content,w.revision,w.updated_at,'))currentReads++;return f.db.prepare(sql);},batch:statements=>f.db.batch(statements)};
 await loadWorkspace(db,owner,workspaceFixture,now);
 currentReads=0;
 await readCurrent(db,owner,now);
 await measureProspectiveRecoverability(db,owner,{now});
 assert.equal(currentReads,3);
 currentReads=0;
 const captured=await capturePlanningForRecoverability(db,owner,scope);
 await measureProspectiveRecoverability(db,owner,{now,planningCapture:captured.capture});
 assert.equal(currentReads,2);
 }finally{f.sqlite.close();}
});

test('a caller cannot retag the validated operation scope while the owner read is pending',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,owner,workspaceFixture,now);
 let release!:()=>void,started!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;}),reading=new Promise<void>(resolve=>{started=resolve;});
 const db:SqlDatabase={prepare(sql){
 const native=f.db.prepare(sql);
 if(!sql.startsWith('SELECT w.content,w.revision,w.updated_at,'))return native;
 return {bind(...values){native.bind(...values);return this;},async first<T>(){started();await pending;return native.first<T>();},async all<T>(){return native.all<T>();},run:()=>native.run()};
 },batch:statements=>f.db.batch(statements)};
 const mutable={...scope},original={...mutable},work=capturePlanningForRecoverability(db,owner,mutable);
 await reading;
 mutable.now='2026-10-19T12:00:00.000Z';mutable.mutationId='retagged_operation';mutable.expectedRevision=2;
 release();
 const captured=await work;
 assert.deepEqual({now:captured.capture.now,mutationId:captured.capture.mutationId,expectedRevision:captured.capture.expectedRevision},original);
 assert.equal(consumePlanningCapture(db,owner,now,captured.capture).revision,1);
 }finally{f.sqlite.close();}
});

test('preflight batches unchanged planning/count SQL and keeps the capture bound to the real database',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,owner,workspaceFixture,now);
 const batches:number[]=[],sql:string[]=[];
 const db:SqlDatabase={prepare(query){sql.push(query);return f.db.prepare(query);},batch(statements){batches.push(statements.length);return f.db.batch(statements);}};
 const preflight=await capturePlanningPreflight(db,owner,scope);
 assert.deepEqual(batches,[2]);assert.equal(preflight.readReceiptCount(),0);
 assert.deepEqual(preflight.before,await readCurrent(f.db,owner,now));
 assert.equal(sql.filter(query=>query==='SELECT COUNT(*) AS count FROM workspace_mutations WHERE user_id=?').length,1);
 assert.throws(()=>consumePlanningCapture(f.db,owner,now,preflight.capture),/Invalid or consumed/);
 assert.equal(consumePlanningCapture(db,owner,now,preflight.capture).revision,1);
 }finally{f.sqlite.close();}
});
test('stale revision can retain its original conflict priority over a failed receipt decoder',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,owner,workspaceFixture,now);
 const db:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){const results=await f.db.batch(statements);return results.map((result,index)=>index===1?{...result,results:[{count:-1}]}:result);}};
 const preflight=await capturePlanningPreflight(db,owner,{...scope,expectedRevision:2});
 assert.equal(preflight.before.revision,1); // caller returns conflict before observing count
 assert.throws(()=>preflight.readReceiptCount(),/Receipt usage is unavailable/);
 assert.throws(()=>consumePlanningCapture(db,owner,now,preflight.capture),/Invalid or consumed/);
 }finally{f.sqlite.close();}
});
test('batch storage errors retain planning-first failure and issue no mutations',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,owner,workspaceFixture,now);let calls=0;
 const failure=new Error('synthetic batch read unavailable');
 const db:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(){calls++;throw failure;}};
 await assert.rejects(capturePlanningPreflight(db,owner,scope),error=>error===failure);
 assert.equal(calls,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM workspace_mutations').get()!.count,0);
 }finally{f.sqlite.close();}
});

test('baseline candidate hydration remains dependent and matches the original reader',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);
 const batches:number[]=[],queries:string[]=[];
 const db:SqlDatabase={prepare(sql){queries.push(sql);return f.db.prepare(sql);},batch(statements){batches.push(statements.length);return f.db.batch(statements);}};
 const preflight=await capturePlanningPreflight(db,owner,scope);
 assert.deepEqual(batches,[2,1]);
 assert.ok(queries[2].startsWith('SELECT DISTINCT entity_id FROM audit_events '));
 assert.deepEqual(preflight.before,await readCurrent(f.db,owner,now));
 assert.equal(preflight.readReceiptCount(),0);
 }finally{f.sqlite.close();}
});
