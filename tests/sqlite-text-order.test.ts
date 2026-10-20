import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {compareSqliteText} from '../lib/sqlite-text-order.ts';
test('comparison matches actual SQLite UTF8 BINARY order without locale or canonical normalization',()=>{
 const sqlite=new DatabaseSync(':memory:');try{
  sqlite.exec('CREATE TABLE selected_ids(id TEXT NOT NULL PRIMARY KEY)');
  const values=['','a','aa','a-b','A','0','é','e\u0301','\uE000','\u{10000}','\uFFFF','\u{10ffff}','😀','中'];
  const insert=sqlite.prepare('INSERT INTO selected_ids(id) VALUES(?)');for(const value of values)insert.run(value);
  const actual=sqlite.prepare('SELECT id FROM selected_ids ORDER BY id COLLATE BINARY').all().map(row=>row.id);
  assert.deepEqual([...values].sort(compareSqliteText),actual);
  for(const value of values)assert.equal(compareSqliteText(value,value),0);
  assert.ok(compareSqliteText('a','aa')<0);assert.ok(compareSqliteText('\uE000','\u{10000}')<0);assert.notEqual(compareSqliteText('é','e\u0301'),0);
 }finally{sqlite.close();}
});
