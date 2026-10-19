import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {OWNER_TABLES,type RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import {buildRecoveryReadPageQueries,decodeRecoveryReadPages,readRecoveryReadPages,type RecoveryReadPageInput} from '../lib/recoverability-read-pages.ts';
import type {SqlDatabase} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
const owner='synthetic-union-owner',now='2026-10-18T12:00:00.000Z';
const allInput=():RecoveryReadPageInput=>({tables:OWNER_TABLES.map(table=>({table,after:''})),audit:{after:'',watermarks:{sources:0}}});
async function rawPages(db:SqlDatabase,input:RecoveryReadPageInput){const queries=buildRecoveryReadPageQueries(owner,input),pages=await db.batch(queries.map(query=>db.prepare(query.sql).bind(...query.bindings)));return pages.flatMap(page=>page.results??[]);}
test('closed query bounds native compound terms, placeholders and SQL size while certifying every empty physical and audit page',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);
  const input=allInput(),queries=buildRecoveryReadPageQueries(owner,input);assert.equal(queries.length,8);
  assert.deepEqual(queries.map(query=>(query.sql.match(/ AS snapshot_tag/gu)??[]).length),[5,5,5,5,5,5,5,2]);
  for(const query of queries){assert.ok(query.bindings.length<=100);assert.equal((query.sql.match(/\?/gu)??[]).length,query.bindings.length);assert.ok(new TextEncoder().encode(query.sql).byteLength<=100000);assert.equal(query.bindings.filter(value=>value===owner).length,1);assert.ok(!/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(query.sql));assert.ok(query.sql.endsWith('ORDER BY snapshot_tag COLLATE BINARY,id COLLATE BINARY'));}
  const rows=await rawPages(f.db,input);assert.equal(rows.length,37);assert.ok(rows.every(row=>(row as {snapshot_empty:number}).snapshot_empty===1));
  const result=decodeRecoveryReadPages(input,rows);assert.equal(result.physical.size,36);for(const rows of result.physical.values())assert.deepEqual(rows,[]);assert.deepEqual(result.auditPage,[]);
  assert.throws(()=>buildRecoveryReadPageQueries(owner,{tables:[{table:'evidence_records; DELETE FROM workspaces' as RegisteredOwnerTable,after:''}]}),/closed recovery/);
  assert.throws(()=>buildRecoveryReadPageQueries(owner,{tables:[{table:'evidence_records',after:''},{table:'evidence_records',after:''}]}),/closed recovery/);
 }finally{f.sqlite.close();}
});
test('native cursor pages preserve exact original rows, UTF8 BINARY ordering, stream columns, audit nulls and owner isolation',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);
  const ids=['key-\uE000','key-\u{10000}'],payload=canonical({text:'Exact Unicode العربية 😀'}),digest=await contentHash(payload);
  for(const id of ids)f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(owner,id,payload,digest);
  f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('foreign-owner','foreign-key',payload,digest);
  const eventPayload=canonical({text:'Original audit null mirrors'});f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,0,NULL,NULL,?,?,NULL,?,?)').run(owner,'audit-native','synthetic','workspace',now,eventPayload);
  const input=allInput(),result=await readRecoveryReadPages(f.db,owner,input);
  const actual=f.sqlite.prepare('SELECT id,row_revision,payload_json,content_hash FROM evidence_records WHERE user_id=? ORDER BY id COLLATE BINARY').all(owner);
  assert.deepEqual(result.physical.get('evidence_records'),actual.map(row=>({...row})));assert.deepEqual(result.physical.get('evidence_records')!.map(row=>row.id),ids);
  assert.ok(result.physical.get('evidence_records')!.every(row=>!Object.hasOwn(row,'stream_sequence')));
  assert.deepEqual(result.auditPage,f.sqlite.prepare('SELECT event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json FROM audit_events WHERE user_id=? ORDER BY event_id').all(owner).map(row=>({...row})));
  const later=await readRecoveryReadPages(f.db,owner,{tables:[{table:'evidence_records',after:ids[0]}]});assert.deepEqual(later.physical.get('evidence_records')!.map(row=>row.id),[ids[1]]);
  const empty=await readRecoveryReadPages(f.db,owner,{tables:[{table:'evidence_records',after:ids[1]}]});assert.deepEqual(empty.physical.get('evidence_records'),[]);
  // Stream reconstruction is tested independently of domain payload validity.
  const raw=await rawPages(f.db,{tables:[{table:'source_observations',after:''}]}),stream={...(raw[0] as Record<string,unknown>),snapshot_empty:0,id:'stream-original',row_revision:1,payload_json:'{}',content_hash:digest,stream_sequence:7};
  assert.deepEqual(decodeRecoveryReadPages({tables:[{table:'source_observations',after:''}]},[stream]).physical.get('source_observations'),[{id:'stream-original',row_revision:1,payload_json:'{}',content_hash:digest,stream_sequence:7}]);
 }finally{f.sqlite.close();}
});
test('every missing, duplicate, unexpected, malformed, mixed or oversized tag refuses the complete image',async()=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);
  const input=allInput(),base=await rawPages(f.db,input),index=base.findIndex(row=>(row as {snapshot_tag:string}).snapshot_tag==='evidence_records'),empty={...(base[index] as Record<string,unknown>)},data={...empty,snapshot_empty:0,id:'a',row_revision:1,payload_json:'{}',content_hash:'a'.repeat(64)};
  const copy=()=>base.map(row=>({...row as Record<string,unknown>}));
  const cases:unknown[][]=[];
  const missing=copy();missing.splice(index,1);cases.push(missing);
  const duplicate=copy();duplicate.splice(index,0,empty);cases.push(duplicate);
  const unexpected=copy();unexpected[index]={...empty,snapshot_tag:'foreign-unregistered'};cases.push(unexpected);
  const padding=copy();padding[index]={...empty,occurred_at:now};cases.push(padding);
  const mixed=copy();mixed.splice(index+1,0,data);cases.push(mixed);
  const repeated=copy();repeated.splice(index,1,data,data);cases.push(repeated);
  const overflow=copy();overflow.splice(index,1,...Array.from({length:201},(_,i)=>({...data,id:'row-'+String(i).padStart(4,'0')})));cases.push(overflow);
  const shape=copy();shape[index]={...empty,unexpected:true};cases.push(shape);
  const nonstream=copy();nonstream[index]={...data,stream_sequence:0};cases.push(nonstream);
  cases.push([...copy()].reverse());
  for(const rows of cases)assert.throws(()=>decodeRecoveryReadPages(input,rows),/closed recovery/);
  const after={tables:[{table:'evidence_records' as const,after:'z'}]};assert.throws(()=>decodeRecoveryReadPages(after,[data]),/closed recovery/);
  let groups=0;const broken:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){groups=statements.length;const rows=await f.db.batch(statements);return rows.slice(0,1);}};
  await assert.rejects(()=>readRecoveryReadPages(broken,owner,input),/closed recovery/);assert.equal(groups,8);
 }finally{f.sqlite.close();}
});
test('actual Miniflare D1 executes native-calibrated <=5-branch groups at full owner scope with 450 physical and audit records, certificates and exact frozen pages',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readdir,readFile}=await import('node:fs/promises');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic union proof")}}',d1Databases:{DB:'synthetic-union-proof'}});
 try{
  const db=await mf.getD1Database('DB'),files=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
  for(const name of files)for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
  await loadWorkspace(db,owner,workspaceFixture,now);
  const payload=canonical({text:'Native exact Unicode العربية 😀'}),digest=await contentHash(payload);
  const inserts=[];for(let i=0;i<450;i++){const id='row-'+String(i).padStart(4,'0');inserts.push(db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(owner,id,payload,digest));inserts.push(db.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,?,?,?,NULL,?,?)').bind(owner,id,i,'synthetic','workspace',now,payload));}
  for(let offset=0;offset<inserts.length;offset+=50)await db.batch(inserts.slice(offset,offset+50));
  await db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind('foreign-owner','foreign-key',payload,digest).run();
  const selected:string[]=[],audit:string[]=[];let after='',auditAfter='';
  for(let round=0;round<3;round++){
   const input:RecoveryReadPageInput={tables:OWNER_TABLES.map(table=>({table,after:table==='evidence_records'?after:''})),audit:{after:auditAfter,watermarks:{sources:0}}};
   const queries=buildRecoveryReadPageQueries(owner,input);assert.equal(queries.length,8);assert.ok(queries.every(query=>(query.sql.match(/ AS snapshot_tag/gu)??[]).length<=5&&query.bindings.length<=100));
   const page=await readRecoveryReadPages(db,owner,input),physical=page.physical.get('evidence_records')!,events=page.auditPage!;assert.equal(physical.length,round<2?200:50);assert.equal(events.length,round<2?200:50);
   for(const row of physical){assert.equal(row.payload_json,payload);assert.equal(row.content_hash,digest);assert.equal(Object.hasOwn(row,'stream_sequence'),false);selected.push(row.id as string);}for(const row of events){assert.equal(row.payload_json,payload);assert.equal(row.stream_id,null);assert.equal(row.stream_sequence,null);audit.push(row.event_id as string);}
   after=selected.at(-1)!;auditAfter=audit.at(-1)!;
  }
  assert.equal(selected.length,450);assert.equal(new Set(selected).size,450);assert.deepEqual(audit,selected);assert.equal(selected.includes('foreign-key'),false);
  const native=(await db.prepare('SELECT id,row_revision,payload_json,content_hash FROM evidence_records WHERE user_id=? ORDER BY id COLLATE BINARY').bind(owner).all()).results;
  assert.deepEqual(native.map(row=>row.id),selected);assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_mutations').first<{n:number}>())!.n,0);
 }finally{await mf.dispose();}
});
