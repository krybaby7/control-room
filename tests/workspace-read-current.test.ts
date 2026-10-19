import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {openPlanningCasDatabase} from './helpers/planning-cas-database.ts';
import {workspaceFixture,taskFixture,projectFixture} from './helpers/workspace.ts';
import {readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {encodePlanning,decodePlanning} from '../lib/workspace-codec.ts';
import {baselineRecordId} from '../lib/project-baselines.ts';
import {currentWeek} from '../lib/calendar.ts';
import {hydrateCurrentWeeklyPins} from '../lib/weekly-planning.ts';
const now='2026-10-18T22:00:00.000Z',week=currentWeek(now);
const schema=[
 'CREATE TABLE workspaces(user_id TEXT PRIMARY KEY,content TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)',
 'CREATE TABLE workspace_recovery(user_id TEXT PRIMARY KEY,content TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)',
 'CREATE TABLE audit_events(user_id TEXT NOT NULL,kind TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL)',
 'CREATE TABLE weekly_plans(user_id TEXT NOT NULL,id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(user_id,id))',
];
async function exercise(db:SqlDatabase){
 for(const sql of schema)await db.prepare(sql).run();
 const workspace=workspaceFixture({tasks:[taskFixture('selected'),taskFixture('unselected',{weekly:true,weeklyWeek:week}),taskFixture('historical',{weekly:true,weeklyWeek:'2026-10-05'}),taskFixture('proposal',{status:'proposed'})]}),content=encodePlanning(workspace);
 for(const owner of ['synthetic-a','synthetic-b'])await db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').bind(owner,content,7,now).run();
 // Revision zero is still an existing recovery copy, not a falsy availability flag.
 await db.prepare('INSERT INTO workspace_recovery VALUES(?,?,?,?)').bind('synthetic-b',content,0,now).run();
 const plan={weekStart:week,capacityMinutes:120,taskIds:['selected','proposal'],revision:3};
 await db.prepare('INSERT INTO weekly_plans VALUES(?,?,?)').bind('synthetic-a',week,JSON.stringify(plan)).run();
 await db.prepare('INSERT INTO weekly_plans VALUES(?,?,?)').bind('synthetic-b','2026-10-05','invalid other-week payload').run();
 let reads=0;const counted:SqlDatabase={prepare(sql){reads++;return db.prepare(sql);},batch:statements=>db.batch(statements)};
 const a=await readCurrent(counted,'synthetic-a',now);
 assert.equal(reads,1,'workspace/recovery/current-week must use one actual read');
 assert.deepEqual(a,{workspace:hydrateCurrentWeeklyPins(decodePlanning(content,now),plan,now),revision:7,updatedAt:now,previousBackupAvailable:false});
 assert.equal(a.workspace.tasks.find(task=>task.id==='proposal')!.weekly,false,'hydration never accepts proposals');
 reads=0;const b=await readCurrent(counted,'synthetic-b',now);
 assert.equal(reads,1);assert.deepEqual(b,{workspace:decodePlanning(content,now),revision:7,updatedAt:now,previousBackupAvailable:true});
 reads=0;await assert.rejects(readCurrent(counted,'missing-owner',now),/workspace could not be loaded/);assert.equal(reads,1);
 await db.prepare('UPDATE weekly_plans SET payload_json=? WHERE user_id=? AND id=?').bind('{"unknown":true}','synthetic-a',week).run();
 await assert.rejects(readCurrent(db,'synthetic-a',now),'malformed current-week metadata must still fail closed');
 assert.equal((await readCurrent(db,'synthetic-b',now)).previousBackupAvailable,true,'foreign malformed weekly metadata must not leak');
 await db.prepare('UPDATE workspaces SET content=? WHERE user_id=?').bind('invalid planning JSON','synthetic-a').run();
 await assert.rejects(readCurrent(db,'synthetic-a',now),'the original planning decoder remains authoritative');
 const baselineWorkspace=workspaceFixture({projects:[projectFixture({repositories:[{name:'Synthetic baseline identity',url:'https://github.com/krybaby7/tameni-map-lab'}]})]}),removedId=baselineRecordId('p1','context');
 await db.prepare('UPDATE workspaces SET content=? WHERE user_id=?').bind(encodePlanning(baselineWorkspace),'synthetic-b').run();
 await db.prepare('INSERT INTO audit_events VALUES(?,?,?,?)').bind('synthetic-a','entity.delete','capture',removedId).run();
 reads=0;assert.equal((await readCurrent(counted,'synthetic-b',now)).baselineRemovedIds,undefined);assert.equal(reads,2,'baseline deletion history remains a separate dependent owner read');
 await db.prepare('INSERT INTO audit_events VALUES(?,?,?,?)').bind('synthetic-b','entity.delete','capture',removedId).run();
 reads=0;assert.deepEqual((await readCurrent(counted,'synthetic-b',now)).baselineRemovedIds,[removedId]);assert.equal(reads,2);
}
test('readCurrent coquery preserves native SQLite owner/recovery/weekly semantics in one read',async()=>{
 const fixture=openPlanningCasDatabase(':memory:');
 try{await exercise(fixture.db);}finally{fixture.sqlite.close();}
});
test('readCurrent coquery has identical actual D1 owner/recovery/weekly semantics',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic read fixture")}}',compatibilityDate:'2026-05-22',d1Databases:['DB']});
 try{
  const native=await mf.getD1Database('DB');
  const db:SqlDatabase={prepare(sql){let prepared=native.prepare(sql);return {bind(...values){prepared=prepared.bind(...values);return this;},first<T>(){return prepared.first<T>();},all<T>(){return prepared.all<T>();},async run(){const result=await prepared.run();return {meta:{changes:result.meta.changes}};}};},async batch(){throw new Error('This read fixture never needs a batch.');}};
  await exercise(db);
 }finally{await mf.dispose();}
});
