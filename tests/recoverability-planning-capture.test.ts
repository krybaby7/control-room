import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {capturePlanningForRecoverability,consumePlanningCapture} from '../lib/recoverability-planning-capture.ts';
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
 const ordinary=await measureProspectiveRecoverability(db,owner,{now}),first=await capturePlanningForRecoverability(db,owner,scope);
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
