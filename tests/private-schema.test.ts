import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import type {SqlDatabase} from '../lib/workspace-store.ts';
import {PRIVATE_PROFILE_TABLES} from '../lib/private-profile.ts';
import {privateSchemaMetadata} from '../lib/private-schema.ts';
function instrument(db:SqlDatabase){const counts={schema:0,pragma:0},observed:SqlDatabase={prepare(sql){if(sql.startsWith('SELECT name,sql FROM sqlite_master'))counts.schema++;if(sql.startsWith('PRAGMA table_info('))counts.pragma++;return db.prepare(sql);},batch:statements=>db.batch(statements)};return {db:observed,counts};}
test('20 concurrent actual SQLite callers share one closed-profile column discovery and retain per-call schema checks',async()=>{
 const f=database(),observed=instrument(f.db);try{
  const values=await Promise.all(Array.from({length:20},()=>privateSchemaMetadata(observed.db)));
  assert.equal(observed.counts.schema,20);assert.equal(observed.counts.pragma,PRIVATE_PROFILE_TABLES.length);
  for(const value of values){assert.equal(value.tables,values[0].tables);assert.equal(Object.isFrozen(value.tables),true);for(const table of PRIVATE_PROFILE_TABLES){assert.equal(Object.isFrozen(value.tables[table]),true);assert.ok(value.tables[table].length);assert.equal(Object.isFrozen(value.tables[table][0]),true);}assert.ok(await f.db.prepare('SELECT 1 WHERE '+value.guard.sql).bind(...value.guard.bindings).first());}
  await privateSchemaMetadata(observed.db);assert.equal(observed.counts.schema,21);assert.equal(observed.counts.pragma,PRIVATE_PROFILE_TABLES.length);
 }finally{f.sqlite.close();}
});
test('unsupported actual ALTER invalidates old proof and rejects the new schema without touching owner records',async()=>{
 const f=database(),observed=instrument(f.db);try{
  f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').run('schema-owner','synthetic-schema-receipt','a'.repeat(64),1,'2026-10-18T12:00:00.000Z');
  const original=f.sqlite.prepare('SELECT * FROM workspace_mutations').all(),old=await privateSchemaMetadata(observed.db);
  f.sqlite.exec('ALTER TABLE workspace_mutations ADD COLUMN synthetic_extra TEXT');
  assert.equal(await f.db.prepare('SELECT 1 WHERE '+old.guard.sql).bind(...old.guard.bindings).first(),null);
  await assert.rejects(privateSchemaMetadata(observed.db),/compiled contract/);
  assert.equal(old.tables.workspace_mutations.some(column=>column.name==='synthetic_extra'),false);assert.equal(observed.counts.pragma,PRIVATE_PROFILE_TABLES.length*2);
  const remaining=f.sqlite.prepare('SELECT user_id,mutation_id,command_hash,revision,committed_at FROM workspace_mutations').all();assert.deepEqual(remaining,original);
 }finally{f.sqlite.close();}
});
test('schema change between quote and actual batch aborts every owner write under the returned guard',async()=>{
 const f=database();try{
  const proof=await privateSchemaMetadata(f.db);f.sqlite.exec('ALTER TABLE agent_budgets ADD COLUMN synthetic_late TEXT');
  await assert.rejects(f.db.batch([
   f.db.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').bind('schema-owner','must-rollback','a'.repeat(64),1,'2026-10-18T12:00:00.000Z'),
   f.db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+proof.guard.sql+' THEN 1 ELSE 0 END').bind('schema-owner','schema-race',...proof.guard.bindings),
  ]));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_assertions').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('schema metadata is isolated per actual database and rejects missing closed tables',async()=>{
 const a=database(),b=database(),first=instrument(a.db),second=instrument(b.db);try{
  const left=await privateSchemaMetadata(first.db),right=await privateSchemaMetadata(second.db);assert.notEqual(left.tables,right.tables);assert.equal(first.counts.pragma,PRIVATE_PROFILE_TABLES.length);assert.equal(second.counts.pragma,PRIVATE_PROFILE_TABLES.length);
  b.sqlite.exec('DROP TABLE audit_project_links');
  await assert.rejects(privateSchemaMetadata(second.db),/schema is unavailable/);
  assert.ok(await a.db.prepare('SELECT 1 WHERE '+left.guard.sql).bind(...left.guard.bindings).first());
 }finally{a.sqlite.close();b.sqlite.close();}
});

test('unsupported actual changed scalar default cannot be accepted after older insert hydration',async()=>{
 const f=database();try{
  const old=await privateSchemaMetadata(f.db),row=f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_budgets'").get()!,original=String(row.sql),changed=original.replace(/\bDEFAULT\s+0\b/iu,'DEFAULT 1');assert.notEqual(changed,original);
  // Rebuild only this empty synthetic fixture table to change a real default;
  // owner workspace data is not migrated, deleted or rewritten by the helper.
  f.sqlite.exec('ALTER TABLE agent_budgets RENAME TO synthetic_previous_budgets');f.sqlite.exec(changed);f.sqlite.exec('DROP TABLE synthetic_previous_budgets');
  assert.equal(await f.db.prepare('SELECT 1 WHERE '+old.guard.sql).bind(...old.guard.bindings).first(),null);
  await assert.rejects(privateSchemaMetadata(f.db),/compiled contract/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_budgets').get()!.n,0);
 }finally{f.sqlite.close();}
});
