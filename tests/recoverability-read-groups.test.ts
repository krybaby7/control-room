import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {OWNER_TABLES} from '../lib/workspace-modules.ts';
import {readRecoveryReadPageGroups,type RecoveryReadPageInput} from '../lib/recoverability-read-pages.ts';
import type {SqlDatabase} from '../lib/workspace-store.ts';
const owner='synthetic-group-owner',now='2026-10-22T12:00:00Z';
const inputs=():RecoveryReadPageInput[]=>[{tables:OWNER_TABLES.slice(0,36).map(table=>({table,after:''})),audit:{after:'',watermarks:{}}},{tables:OWNER_TABLES.slice(36).map(table=>({table,after:''}))}];
test('two independently bounded inventory queries use one native batch and retain every physical/audit certificate',async()=>{
 const f=database();try{await loadWorkspace(f.db,owner,workspaceFixture,now);let calls=0,statements=0;
 const db:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(batch){calls++;statements=batch.length;return f.db.batch(batch);}};
 const result=await readRecoveryReadPageGroups(db,owner,inputs());assert.equal(calls,1);assert.equal(statements,2);assert.equal(result.length,2);assert.deepEqual([...result.flatMap(group=>[...group.physical.keys()])].sort(),[...OWNER_TABLES].sort());assert.deepEqual(result[0].auditPage,[]);assert.equal(result[1].auditPage,undefined);
 }finally{f.sqlite.close();}
});
test('group inventory ambiguity is rejected before issuing SQL',async()=>{
 const db:SqlDatabase={prepare(){throw Error('unexpected SQL');},async batch(){throw Error('unexpected batch');}};
 const selected=inputs();for(const bad of [[],[...selected,selected[0]],[selected[0],selected[0]],[selected[0],{...selected[1],audit:{after:'',watermarks:{}}}]])await assert.rejects(readRecoveryReadPageGroups(db,owner,bad),/closed recovery/);
});
test('missing/extra batch results and cross-group response tags fail closed',async()=>{
 const f=database();try{await loadWorkspace(f.db,owner,workspaceFixture,now);
 for(const mutate of [(rows:Awaited<ReturnType<SqlDatabase['batch']>>)=>rows.slice(0,1),(rows:Awaited<ReturnType<SqlDatabase['batch']>>)=>[...rows,rows[0]],(rows:Awaited<ReturnType<SqlDatabase['batch']>>)=>[rows[1],rows[0]],(rows:Awaited<ReturnType<SqlDatabase['batch']>>)=>[rows[0],{...rows[1],results:[]}]]){
 const db:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(batch){return mutate(await f.db.batch(batch));}};await assert.rejects(readRecoveryReadPageGroups(db,owner,inputs()),/closed recovery/);
 }
 }finally{f.sqlite.close();}
});
test('actual D1 executes both closed statements in one batch with independent nonempty tails and cursors',async()=>{
 const {Miniflare}=await import('miniflare'),{readdir,readFile}=await import('node:fs/promises');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic grouped proof")}}',d1Databases:{DB:'synthetic-groups'}});
 try{const native=await mf.getD1Database('DB');
 for(const name of (await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort())for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await native.prepare(sql.trim()).run();
 const {contentHash}=await import('../lib/canonical-json.ts'),payload='{}',digest=await contentHash(payload);
 await native.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(owner,'head',payload,digest).run();
 await native.prepare('INSERT INTO personal_repository_state(user_id,id,row_revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?)').bind(owner,'tail',payload,digest,now).run();
 let calls=0;const db:SqlDatabase={prepare:sql=>native.prepare(sql),async batch(batch){calls++;assert.equal(batch.length,2);return native.batch(batch as Parameters<typeof native.batch>[0]);}};
 const result=await readRecoveryReadPageGroups(db,owner,inputs());assert.equal(calls,1);assert.equal(result[0].physical.get('evidence_records')![0].id,'head');assert.equal(result[1].physical.get('personal_repository_state')![0].id,'tail');
 const later=inputs().map(group=>({...group,tables:group.tables.map(value=>({...value,after:value.table==='evidence_records'?'head':value.table==='personal_repository_state'?'tail':''}))}));const empty=await readRecoveryReadPageGroups(db,owner,later);assert.deepEqual(empty[0].physical.get('evidence_records'),[]);assert.deepEqual(empty[1].physical.get('personal_repository_state'),[]);assert.equal(calls,2);
 }finally{await mf.dispose();}
});
