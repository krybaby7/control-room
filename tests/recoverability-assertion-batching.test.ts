import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare} from 'miniflare';
import {recoverabilityAssertions} from '../lib/recoverability-admission.ts';
import type {ProspectiveRecoverabilityResult} from '../lib/recoverability-snapshot.ts';
import type {SqlDatabase,SqlStatement} from '../lib/workspace-store.ts';

// Isolated physical proof fixture: no domain commands, credentials or authority.
// Real SQLite and D1 execute the production assertions over twelve populated
// owner rowsets, including a foreign row in each table.
const tables=['evidence_mappings','evidence_records','evidence_versions','evidence_links','decisions','attachments','attachment_usage','decision_records','decision_versions','source_connections','source_targets','devices'] as const;
const owner='synthetic-grouped-owner',hash='a'.repeat(64);
function quote():ProspectiveRecoverabilityResult{return {
 measurement:{allowed:true},boundaryRevision:1,boundaryWatermarks:{sources:0},
 boundaryRows:tables.map(table=>({table,rows:[{id:'retained',row_revision:1,content_hash:hash}]})),agentTerminalReserveRows:[]
} as unknown as ProspectiveRecoverabilityResult;}
function and(parts:string[]):string{if(parts.length===1)return parts[0];const n=Math.floor(parts.length/2);return '('+and(parts.slice(0,n))+' AND '+and(parts.slice(n))+')';}
async function setup(db:SqlDatabase){
 for(const sql of [
 'CREATE TABLE workspaces(user_id TEXT PRIMARY KEY,revision INTEGER)',
 'CREATE TABLE operational_stream_heads(user_id TEXT,stream_id TEXT,last_sequence INTEGER)',
 'CREATE TABLE agent_job_state(user_id TEXT,job_id TEXT,operational_revision INTEGER,status TEXT,approval_id TEXT)',
 'CREATE TABLE workspace_assertions(user_id TEXT,mutation_id TEXT,valid INTEGER CHECK(valid=1))',
 'CREATE TABLE effects(id TEXT PRIMARY KEY)',
 ...tables.map(table=>'CREATE TABLE '+table+'(user_id TEXT,id TEXT,row_revision INTEGER,content_hash TEXT,PRIMARY KEY(user_id,id))')
 ])await db.prepare(sql).run();
 await db.prepare('INSERT INTO workspaces VALUES(?,1)').bind(owner).run();
 for(const table of tables)for(const selected of [owner,'foreign'])await db.prepare('INSERT INTO '+table+' VALUES(?,?,1,?)').bind(selected,'retained',hash).run();
}
function compile(db:SqlDatabase,q=quote(),gateCount=3){
 const captured:{sql:string;bindings:(string|number|null)[]}[]=[];
 const instrumented={...db,prepare(sql:string){return {bind(...bindings:(string|number|null)[]){captured.push({sql,bindings});return db.prepare(sql).bind(...bindings);}};}} as unknown as SqlDatabase;
 const statements=recoverabilityAssertions(instrumented,owner,'synthetic-mutation',q,and(Array.from({length:gateCount},()=>'?=1')),Array(gateCount).fill(1));
 return {statements,captured};
}
async function exercise(db:SqlDatabase){
 await setup(db);
 for(const count of [3,60,92]){
  const built=compile(db,quote(),count);
  assert.equal(built.statements.length,2+Math.ceil(12/Math.min(12,Math.floor((98-count)/4))));
  assert.ok(built.captured.every(item=>item.bindings.length<=100));
  assert.ok(built.captured.every(item=>(item.sql.match(/ EXCEPT /g)||[]).length<=12));
  assert.match(built.captured[0].sql,/operational_stream_heads/);
  assert.match(built.captured.at(-1)!.sql,/agent_job_state/);
  await db.batch([...built.statements,db.prepare('DELETE FROM workspace_assertions')]);
 }
 for(const index of [0,5,11])for(const mode of ['insert','update','delete'] as const){
  const table=tables[index],built=compile(db);
  if(mode==='insert')await db.prepare('INSERT INTO '+table+' VALUES(?,?,1,?)').bind(owner,'racing',hash).run();
  else if(mode==='update')await db.prepare('UPDATE '+table+' SET row_revision=2 WHERE user_id=?').bind(owner).run();
  else await db.prepare('DELETE FROM '+table+' WHERE user_id=?').bind(owner).run();
  await assert.rejects(db.batch([db.prepare("INSERT INTO effects VALUES('must-rollback')"),...built.statements,db.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').bind(owner)]));
  assert.equal(await db.prepare('SELECT id FROM effects').first(),null);
  assert.equal(await db.prepare('SELECT valid FROM workspace_assertions').first(),null);
  assert.equal((await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE user_id=?').bind('foreign').first<{n:number}>())!.n,1);
  if(mode==='insert')await db.prepare('DELETE FROM '+table+' WHERE user_id=? AND id=?').bind(owner,'racing').run();
  else if(mode==='update')await db.prepare('UPDATE '+table+' SET row_revision=1 WHERE user_id=?').bind(owner).run();
  else await db.prepare('INSERT INTO '+table+' VALUES(?,?,1,?)').bind(owner,'retained',hash).run();
 }
 const vector=compile(db);await db.prepare("INSERT INTO operational_stream_heads VALUES(?,'new-stream',1)").bind(owner).run();
 await assert.rejects(db.batch(vector.statements));await db.prepare('DELETE FROM operational_stream_heads').run();
 const terminal=compile(db);await db.prepare("INSERT INTO agent_job_state VALUES(?,'attempt',1,'running','approval')").bind(owner).run();
 await assert.rejects(db.batch(terminal.statements));await db.prepare('DELETE FROM agent_job_state').run();
 const valid=compile(db);await db.batch([db.prepare("INSERT INTO effects VALUES('committed')"),...valid.statements,db.prepare('DELETE FROM workspace_assertions')]);
 assert.equal((await db.prepare('SELECT id FROM effects').first<{id:string}>())!.id,'committed');
}
test('grouped physical proofs retain every first/middle/last insert/update/delete guard and rollback in native SQLite',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 const db={prepare(sql:string){let values:(string|number|null)[]=[];const native=sqlite.prepare(sql);const statement={bind(...args:(string|number|null)[]){values=args;return statement;},async run(){native.run(...values);return {meta:{changes:1}};},async first(){return native.get(...values)||null;},async all(){return {results:native.all(...values)};}};return statement;},async batch(statements:SqlStatement[]){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as SqlDatabase;
 try{await exercise(db);}finally{sqlite.close();}
});
test('actual D1 parses and atomically enforces twelve nonempty proofs and generic 60/92-bind gates',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic grouped assertions")}}',d1Databases:{DB:'synthetic-grouped-assertions'}});
 try{await exercise(await mf.getD1Database('DB') as unknown as SqlDatabase);}finally{await mf.dispose();}
});
test('large escaped UTF8 proof bindings split groups without changing individual proof values or rejecting old singleton',()=>{
 const q=quote(),large='測"\\'.repeat(160000);q.boundaryRows[0].rows[0].id=large;q.boundaryRows[1].rows[0].id=large;
 const db={prepare(sql:string){return {bind(...bindings:(string|number|null)[]){return {sql,bindings};}};}} as unknown as SqlDatabase;
 const built=compile(db,q);assert.ok(built.statements.length>3);
 assert.equal(built.captured.flatMap(item=>item.bindings).filter(value=>typeof value==='string'&&value.includes('測')).length,2);
 assert.ok(built.captured.filter(item=>item.sql.includes(' EXCEPT ')).every(item=>item.bindings.filter(value=>typeof value==='string'&&value.includes('測')).length<=1));
});
