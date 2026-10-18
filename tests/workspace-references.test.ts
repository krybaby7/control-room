import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {OWNER_TABLES,ownerReader,type OwnerScopedReader} from '../lib/workspace-modules.ts';
import {canonical,contentHash} from '../lib/workspace-export.ts';
import {ReferenceRegistry,readReferenceSnapshot,referenceImpact,type TypedReference} from '../lib/workspace-references.ts';
const schema=z.object({text:z.string(),refs:z.array(z.object({kind:z.enum(['project','milestone','task','capture','evidence','decision','attachment']),id:z.string(),path:z.array(z.union([z.string(),z.number()]))}).strict())}).strict();
function registry(){const registry=new ReferenceRegistry();registry.register({key:'evidence_records',schemaVersion:1,entityKind:'evidence',parse:value=>schema.parse(value),references:value=>(value as z.infer<typeof schema>).refs});return registry;}
async function fixture(){const {db,sqlite}=database();return {db,sqlite,async put(owner:string,key:string,refs:TypedReference[]=[],table='evidence_records'){const value={text:owner,refs};sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)`).run(owner,key,JSON.stringify(value),await contentHash(canonical(value)));}};}
test('typed unrelated row permits deletion; exact typed reference blocks it',async()=>{
 const f=await fixture(),planning=createSeedWorkspace('2026-10-18T12:00:00Z'),target={kind:'task' as const,id:planning.tasks[0].id};const r=registry();await f.put('a','unrelated');
 const first=await readReferenceSnapshot(ownerReader(f.db,'a'),r);assert.equal(referenceImpact(planning,first,r,target).canDelete,true);
 await f.put('a','linked',[{...target,path:['refs',0]}]);const second=await readReferenceSnapshot(ownerReader(f.db,'a'),r);const impact=referenceImpact(planning,second,r,target);
 assert.equal(impact.canDelete,false);assert.equal(impact.references[0].sourceId,'linked');assert.deepEqual(impact.dangling,[]);assert.notEqual(first.digest,second.digest);f.sqlite.close();
});
test('missing or unknown descriptors fail closed without inventing schemas',async()=>{
 const f=await fixture();await f.put('a','row');await assert.rejects(readReferenceSnapshot(ownerReader(f.db,'a'),new ReferenceRegistry()),/Missing typed/);
 assert.throws(()=>registry().get('unknown'),/Unknown owner module/);assert.throws(()=>registry().register({key:'evidence_records',schemaVersion:1,parse:v=>v,references:()=>[]}),/duplicate/);f.sqlite.close();
});
test('owner-scoped traversal crosses pages and never reads another owner',async()=>{
 const f=await fixture();for(let n=0;n<205;n++){await f.put('a',String(n).padStart(4,'0'));await f.put('b',String(n).padStart(4,'0'),[{kind:'task',id:'private-b',path:['target']}]);}
 const snapshot=await readReferenceSnapshot(ownerReader(f.db,'a'),registry());assert.equal(snapshot.rows.length,205);assert.ok(snapshot.rows.every(row=>row.references.length===0));assert.equal(snapshot.coveredModules.length,OWNER_TABLES.length);
 const other=await readReferenceSnapshot(ownerReader(f.db,'b'),registry());assert.notEqual(snapshot.digest,other.digest);f.sqlite.close();
});
test('reference validation closes declared kinds and preserves unresolved future kinds',async()=>{
 const f=await fixture(),r=registry(),planning=createSeedWorkspace('2026-10-18T12:00:00Z');await f.put('a','ev',[{kind:'evidence',id:'missing',path:['evidence']},{kind:'decision',id:'future',path:['decision']},{kind:'task',id:'missing-task',path:['task']}]);
 const snapshot=await readReferenceSnapshot(ownerReader(f.db,'a'),r),target={kind:'task' as const,id:planning.tasks[0].id};
 assert.deepEqual(referenceImpact(planning,snapshot,r,target).dangling.map(ref=>ref.kind).sort(),['evidence','task']);
 r.register({key:'decisions',schemaVersion:1,entityKind:'decision',parse:v=>v,references:()=>[]});assert.equal(referenceImpact(planning,snapshot,r,target).dangling.length,3);f.sqlite.close();
});
test('full digest detects changed empty-reference rows and is deterministic',async()=>{
 const f=await fixture(),r=registry();await f.put('a','ev');const query=ownerReader(f.db,'a'),before=await readReferenceSnapshot(query,r);
 assert.equal(before.digest,(await readReferenceSnapshot(query,r)).digest);f.sqlite.prepare('UPDATE evidence_records SET row_revision=2 WHERE user_id=?').run('a');assert.notEqual(before.digest,(await readReferenceSnapshot(query,r)).digest);f.sqlite.close();
});
test('malformed metadata, payload digest, schema and pagination fail closed',async()=>{
 const f=await fixture(),r=registry();await f.put('a','ev');const query=ownerReader(f.db,'a');
 f.sqlite.prepare('UPDATE evidence_records SET content_hash=?').run('a'.repeat(64));await assert.rejects(readReferenceSnapshot(query,r),/digest mismatch/);
 const bad:OwnerScopedReader={get:async()=>null,list:async table=>table==='evidence_records'?[{id:'ev',row_revision:1,payload_json:'{}',content_hash:'bad'}]:[]};await assert.rejects(readReferenceSnapshot(bad,r));
 const value={text:'a',refs:[]},row={id:'ev',row_revision:1,payload_json:JSON.stringify(value),content_hash:await contentHash(canonical(value))};
 await assert.rejects(readReferenceSnapshot({...bad,list:async table=>table==='evidence_records'?[row,row]:[]},r),/pagination/);
 const invalid={text:'a',refs:[],extra:true};await assert.rejects(readReferenceSnapshot({...bad,list:async table=>table==='evidence_records'?[{...row,payload_json:JSON.stringify(invalid)}]:[]},r));
 await assert.rejects(readReferenceSnapshot({...bad,list:async()=>Array.from({length:201},()=>row)},r),/page exceeds limit/);f.sqlite.close();
});
