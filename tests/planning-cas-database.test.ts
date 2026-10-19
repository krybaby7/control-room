import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openPlanningCasDatabase} from './helpers/planning-cas-database.ts';
function plainRow(row:unknown){assert.ok(row!==null&&typeof row==='object'&&!Array.isArray(row));return {...row};}
test('independent-CAS SQLite adapter returns actual coherent batch rows and preserves CTE mutations and rollback',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'control-room-native-batch-')),fixture=openPlanningCasDatabase(join(directory,'synthetic.sqlite'));
 try{
  fixture.sqlite.exec('CREATE TABLE synthetic_batch(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
  const results=await fixture.db.batch([
   fixture.db.prepare("SELECT COUNT(*) n FROM synthetic_batch"),
   fixture.db.prepare("WITH candidate(id,value) AS(SELECT 1,'actual') INSERT INTO synthetic_batch SELECT id,value FROM candidate"),
   fixture.db.prepare('WITH stored AS(SELECT id,value FROM synthetic_batch) SELECT id,value FROM stored'),
   fixture.db.prepare("INSERT INTO synthetic_batch(id,value) VALUES(2,'returning') RETURNING id,value"),
  ]);
  assert.deepEqual(Reflect.get(results[0],'results')?.map(plainRow),[{n:0}]);assert.equal(results[0].meta.changes,0);
  assert.equal(results[1].meta.changes,1);assert.equal(Reflect.get(results[1],'results'),undefined);
  assert.deepEqual(Reflect.get(results[2],'results')?.map(plainRow),[{id:1,value:'actual'}]);assert.equal(results[2].meta.changes,0);
  assert.deepEqual(Reflect.get(results[3],'results')?.map(plainRow),[{id:2,value:'returning'}]);assert.equal(results[3].meta.changes,1);
  await assert.rejects(fixture.db.batch([
   fixture.db.prepare("WITH candidate(id,value) AS(SELECT 3,'rolled back') INSERT INTO synthetic_batch SELECT id,value FROM candidate"),
   fixture.db.prepare("INSERT INTO synthetic_batch(id,value) VALUES(1,'duplicate')"),
  ]));
  assert.deepEqual(fixture.sqlite.prepare('SELECT id,value FROM synthetic_batch ORDER BY id').all().map(row=>({...row})),[{id:1,value:'actual'},{id:2,value:'returning'}]);
 }finally{fixture.sqlite.close();await rm(directory,{recursive:true,force:true});}
});
