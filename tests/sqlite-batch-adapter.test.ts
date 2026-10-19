import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
test('native SQLite batch returns SELECT and WITH SELECT rows with zero changes after an earlier write',async()=>{
 const f=database();try{
  f.sqlite.exec('CREATE TABLE synthetic_batch_values(id TEXT PRIMARY KEY,value INTEGER NOT NULL);INSERT INTO synthetic_batch_values VALUES(\'original\',4);');
  const rows=await f.db.batch([f.db.prepare('SELECT id,value FROM synthetic_batch_values WHERE id=?').bind('original'),f.db.prepare('WITH selected AS(SELECT ? AS id,? AS value) SELECT id,value FROM selected').bind('bound-read',9)]);
  assert.deepEqual(rows.map(row=>row.meta.changes),[0,0]);assert.deepEqual(rows.map(row=>row.results?.map(value=>({...value as Record<string,unknown>}))),[[{id:'original',value:4}],[{id:'bound-read',value:9}]]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM synthetic_batch_values').get()!.n,1);
 }finally{f.sqlite.close();}
});
test('WITH writes retain exact changes and RETURNING rows while batch failure rolls every write back',async()=>{
 const f=database();try{
  f.sqlite.exec('CREATE TABLE synthetic_batch_values(id TEXT PRIMARY KEY,value INTEGER NOT NULL);');
  const result=await f.db.batch([f.db.prepare('WITH inserted AS(SELECT ? AS id,? AS value) INSERT INTO synthetic_batch_values(id,value) SELECT id,value FROM inserted').bind('original',4),f.db.prepare('WITH selected AS(SELECT ? AS id) UPDATE synthetic_batch_values SET value=value+1 WHERE id IN(SELECT id FROM selected) RETURNING id,value').bind('original'),f.db.prepare('WITH selected AS(SELECT ? AS id) SELECT id,value FROM synthetic_batch_values WHERE id IN(SELECT id FROM selected)').bind('original')]);
  assert.deepEqual(result.map(row=>row.meta.changes),[1,1,0]);assert.deepEqual(result[1].results?.map(value=>({...value as Record<string,unknown>})),[{id:'original',value:5}]);assert.deepEqual(result[2].results?.map(value=>({...value as Record<string,unknown>})),[{id:'original',value:5}]);
  const before=f.sqlite.prepare('SELECT * FROM synthetic_batch_values ORDER BY id').all();
  await assert.rejects(f.db.batch([f.db.prepare('WITH inserted AS(SELECT ? AS id,? AS value) INSERT INTO synthetic_batch_values(id,value) SELECT id,value FROM inserted RETURNING id,value').bind('uncommitted',20),f.db.prepare('WITH selected AS(SELECT ? AS id) UPDATE synthetic_batch_values SET value=99 WHERE id IN(SELECT id FROM selected) RETURNING id,value').bind('original'),f.db.prepare('INSERT INTO synthetic_batch_values(id,value) VALUES(?,?)').bind('original',0)]),/UNIQUE/);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM synthetic_batch_values ORDER BY id').all(),before);assert.equal((await f.db.prepare('SELECT value FROM synthetic_batch_values WHERE id=?').bind('original').first<{value:number}>())!.value,5);
 }finally{f.sqlite.close();}
});
