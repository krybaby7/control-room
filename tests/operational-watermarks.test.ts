import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {readOperationalWatermarks,validateOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import type {RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
const now='2026-10-18T12:00:00.000Z';
async function fixture(){const f=database();await loadWorkspace(f.db,'a',()=>workspaceFixture(),now);await loadWorkspace(f.db,'b',()=>workspaceFixture(),now);async function put(table:RegisteredOwnerTable,value:{id:string},owner='a',sequence?:number){const cols=moduleColumnNames(table),projection=await moduleProjection(table,value.id,value as unknown as JsonValue);if(sequence!==undefined)projection.stream_sequence=sequence;f.sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash${cols.map(c=>','+c).join('')}) VALUES(?,?,1,?,?${cols.map(()=>',?').join('')})`).run(owner,value.id,canonical(value),await contentHash(canonical(value)),...cols.map(c=>projection[c]));}
 for(const owner of ['a','b']){await put('source_connections',{id:'connection',provider:'github',label:'Selected',accessMode:'interactive',enabled:true,archivedAt:null} as {id:string},owner);await put('source_targets',{id:'source',connectionId:'connection',projectId:workspaceFixture().projects[0].id,kind:'github_repository',providerResourceId:'synthetic/repo',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null} as {id:string},owner);}
 const run=(id:string)=>({id,sourceId:'source',startedAt:now,finishedAt:now,outcome:'success',pages:1,observations:0,failure:null,retryAt:null,sourceRevision:'revision'});
 return {...f,put,run,head(owner:string,sequence:number,stream='sources'){f.sqlite.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)').run(owner,stream,sequence);}};}
test('absent heads default sources zero; imported zero remains valid and owner stream bounds isolate',async()=>{const f=await fixture();try{assert.deepEqual(await readOperationalWatermarks(f.db,'a'),{sources:0});await f.put('source_sync_runs',f.run('imported'),'a',0);assert.deepEqual(await readOperationalWatermarks(f.db,'a'),{sources:0});f.head('a',3);await f.put('source_sync_runs',f.run('live'),'a',3);f.head('b',900);await f.put('source_sync_runs',f.run('foreign'),'b',900);assert.deepEqual(await readOperationalWatermarks(f.db,'a'),{sources:3});assert.deepEqual(await readOperationalWatermarks(f.db,'b'),{sources:900});}finally{f.sqlite.close();}});
test('missing or low committed head rejects positive source rows and audit above head rejects',async()=>{for(const head of [undefined,2]){const f=await fixture();try{if(head!==undefined)f.head('a',head);await f.put('source_sync_runs',f.run('live'),'a',3);await assert.rejects(readOperationalWatermarks(f.db,'a'),/exceed/);}finally{f.sqlite.close();}}const f=await fixture();try{f.head('a',2);f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?)').run('a','operational-event','sources',3,'source.refresh','source','source',now,'{}');await assert.rejects(readOperationalWatermarks(f.db,'a'),/audit exceeds/);}finally{f.sqlite.close();}});
test('malformed maps, prototype objects, invalid names and unsafe/count bounds reject',async()=>{for(const value of [null,[],Object.create(null),Object.create({sources:1}),{sources:-1},{sources:1.5},{sources:Number.MAX_SAFE_INTEGER+1},{sources:Infinity},{sources:'1'},{'bad.stream':0},Object.fromEntries(Array.from({length:201},(_,i)=>[`stream${i}`,0]))])assert.throws(()=>validateOperationalWatermarks(value));validateOperationalWatermarks({sources:0,audit:5});for(const [name,sequence] of [['bad.stream',1],['sources',-1],['sources',Number.MAX_SAFE_INTEGER+1]] as const){const f=await fixture();try{f.head('a',sequence,name);await assert.rejects(readOperationalWatermarks(f.db,'a'),/Invalid|too large/);}finally{f.sqlite.close();}}const f=await fixture();try{for(let i=0;i<201;i++)f.head('a',0,`stream${i}`);await assert.rejects(readOperationalWatermarks(f.db,'a'),/bound/);}finally{f.sqlite.close();}});
test('concurrent source append causes export retry and returns one coherent advanced watermark snapshot',async()=>{const f=await fixture();try{f.head('a',0);const value=f.run('raced'),columns=moduleColumnNames('source_sync_runs'),projection=await moduleProjection('source_sync_runs',value.id,value as unknown as JsonValue),hash=await contentHash(canonical(value));let raced=false;const db:SqlDatabase={prepare(sql){if(!raced&&sql.includes('SELECT id,row_revision,payload_json,content_hash FROM source_observations')){raced=true;f.sqlite.prepare("UPDATE operational_stream_heads SET last_sequence=1,revision=revision+1 WHERE user_id='a' AND stream_id='sources'").run();f.sqlite.prepare(`INSERT INTO source_sync_runs(user_id,id,row_revision,payload_json,content_hash${columns.map(c=>','+c).join('')}) VALUES('a',?,1,?,?${columns.map(()=>',?').join('')})`).run(value.id,canonical(value),hash,...columns.map(c=>c==='stream_sequence'?1:projection[c]));}return f.db.prepare(sql);},batch:f.db.batch.bind(f.db)};const bundle=await exportWorkspaceBundle(db,'a',{now:()=>now});assert.equal(raced,true);assert.deepEqual(bundle.source.operationalWatermarks,{sources:1});assert.equal(bundle.modules.source_sync_runs.records.length,1);assert.equal((bundle.modules.source_sync_runs.records[0] as {id:string}).id,'raced');assert.equal(bundle.source.workspaceRevision,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workspace_mutations WHERE user_id='a'").get()!.n,0);}finally{f.sqlite.close();}});

test('one owner-bound database read freezes heads and all maxima; a concurrent zero-to-one append is visible only on the next read',async()=>{
 const f=await fixture();try{
  f.head('a',0);f.head('a',4,'custom_context');f.head('b',900);
  const value=f.run('after-query'),cols=moduleColumnNames('source_sync_runs'),projection=await moduleProjection('source_sync_runs',value.id,value as unknown as JsonValue),payload=canonical(value),digest=await contentHash(payload);
  let reads=0,raced=false;
  const db:SqlDatabase={prepare(sql){reads++;assert.ok(sql.startsWith('WITH watermark_owner AS MATERIALIZED'));assert.equal((sql.match(/\?/gu)??[]).length,1);let statement=f.db.prepare(sql);const wrapped:import('../lib/workspace-store.ts').SqlStatement={bind(...values){assert.deepEqual(values,['a']);statement=statement.bind(...values);return wrapped;},async first<T>(){const result=await statement.first<T>();if(!raced){raced=true;f.sqlite.prepare("UPDATE operational_stream_heads SET last_sequence=1,revision=revision+1 WHERE user_id='a' AND stream_id='sources'").run();f.sqlite.prepare(`INSERT INTO source_sync_runs(user_id,id,row_revision,payload_json,content_hash${cols.map(c=>','+c).join('')}) VALUES('a',?,1,?,?${cols.map(()=>',?').join('')})`).run(value.id,payload,digest,...cols.map(c=>c==='stream_sequence'?1:projection[c]));}return result;},all:()=>{throw new Error('No second database read is permitted.');},run:()=>{throw new Error('No write is permitted.');}};return wrapped;},batch:()=>{throw new Error('No batch or write is permitted.');}};
  assert.deepEqual(await readOperationalWatermarks(db,'a'),{sources:0,custom_context:4});assert.equal(reads,1);assert.equal(raced,true);
  assert.deepEqual(await readOperationalWatermarks(f.db,'a'),{sources:1,custom_context:4});assert.deepEqual(await readOperationalWatermarks(f.db,'b'),{sources:900});
 }finally{f.sqlite.close();}
});
test('negative, fractional, nonnumeric and unsafe row maxima still reject the single-statement source proof',async()=>{
 for(const sequence of [-1,1.5,'invalid',Number.MAX_SAFE_INTEGER+1]){const f=await fixture();try{
  f.head('a',10);await f.put('source_sync_runs',f.run('malformed'),'a',0);f.sqlite.prepare('UPDATE source_sync_runs SET stream_sequence=? WHERE user_id=?').run(sequence,'a');
  await assert.rejects(readOperationalWatermarks(f.db,'a'),/Source rows exceed/);
 }finally{f.sqlite.close();}}
});
test('agent audit above its committed head is rejected and a foreign owner audit cannot affect the selected owner',async()=>{
 const f=await fixture();try{
  f.head('a',2,'agents');f.head('b',900,'agents');
  const insert=f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run('b','foreign-agent-audit','agents',900,'agent.complete','agent','foreign',now,'{}');assert.deepEqual(await readOperationalWatermarks(f.db,'a'),{sources:0,agents:2});
  insert.run('a','selected-agent-audit','agents',3,'agent.complete','agent','selected',now,'{}');await assert.rejects(readOperationalWatermarks(f.db,'a'),/Agent audit exceeds/);
 }finally{f.sqlite.close();}
});
test('actual Miniflare D1 runs the one-owner watermark statement and preserves zero, unknown streams, bounds and owner isolation',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readdir,readFile}=await import('node:fs/promises');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic watermark fixture")}}',d1Databases:{DB:'synthetic-operational-watermarks'}});
 try{
  const db=await mf.getD1Database('DB'),files=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
  for(const name of files){for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();}
  assert.deepEqual(await readOperationalWatermarks(db,'synthetic-a'),{sources:0});
  await db.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)').bind('synthetic-a','custom_context',7).run();
  await db.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)').bind('synthetic-b','sources',900).run();
  assert.deepEqual(await readOperationalWatermarks(db,'synthetic-a'),{sources:0,custom_context:7});
  assert.deepEqual(await readOperationalWatermarks(db,'synthetic-b'),{sources:900});
  await db.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,?)').bind('synthetic-a','sources',0).run();
  await db.prepare("INSERT INTO audit_events(user_id,event_id,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,'sources',1,'source.refresh','source',NULL,?,'{}')").bind('synthetic-a','synthetic-zero-race',now).run();
  await assert.rejects(readOperationalWatermarks(db,'synthetic-a'),/audit exceeds/);
  await db.prepare("UPDATE operational_stream_heads SET last_sequence=1 WHERE user_id=? AND stream_id='sources'").bind('synthetic-a').run();
  assert.deepEqual(await readOperationalWatermarks(db,'synthetic-a'),{sources:1,custom_context:7});
  for(let offset=0;offset<200;offset+=50)await db.batch(Array.from({length:50},(_,index)=>db.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,0)').bind('synthetic-a','extra_'+(offset+index))));
  await assert.rejects(readOperationalWatermarks(db,'synthetic-a'),/bound/);
 }finally{await mf.dispose();}
});
