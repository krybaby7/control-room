import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {exportRegistry,type ExportContext} from '../lib/workspace-export.ts';
import {BUNDLE_LIMITS} from '../lib/workspace-export-core.ts';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
const owner='synthetic-recovery-overlap',now='2026-10-22T12:00:00.000Z';
type DigestArgs=Parameters<typeof crypto.subtle.digest>;
async function fixture(corrupt=false){const f=database();await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);const payload=canonical({text:'Retained exact Unicode العربية 🌱'});const digest=await contentHash(payload);await f.db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(owner,'retained',payload,corrupt?'f'.repeat(64):digest).run();return {...f,payload};}
test('the captured physical digest and original serializer overlap without skipping either proof',async t=>{
 const f=await fixture();try{
  const adapter=exportRegistry.get('evidence'),serialize=adapter.exportRows.bind(adapter),digest=crypto.subtle.digest.bind(crypto.subtle);let serializing=false,physicalDigests=0,exportCalls=0;
  const entries=exportRegistry.entries.bind(exportRegistry);t.mock.method(exportRegistry,'entries',()=>entries().map(item=>item.key!=='evidence'?item:{...item,async exportRows(context:ExportContext){exportCalls++;serializing=true;return serialize(context);}}));
  t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{const input=args[1];const bytes=input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength);const physical=new TextDecoder().decode(bytes)===f.payload;return digest(...args).then(result=>{if(physical){physicalDigests++;assert.equal(serializing,true,'serializer starts before the actual physical digest settles');}return result;});});
  const changes=f.sqlite.prepare('SELECT total_changes() n').get()!.n;
  const result=await measureProspectiveRecoverability(f.db,owner,{now});
  assert.equal(result.measurement.allowed,true);assert.equal(physicalDigests,1);assert.equal(exportCalls,2,'original and prospective adapters both execute');assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,changes,'measurement remains read only');
 }finally{f.sqlite.close();}
});
test('a physical hash refusal retains precedence and joins a failed serializer before returning',async t=>{
 const f=await fixture(true);try{
  let serializerSettled=false;const entries=exportRegistry.entries.bind(exportRegistry);
  t.mock.method(exportRegistry,'entries',()=>entries().map(item=>item.key!=='evidence'?item:{...item,async exportRows(){try{await new Promise<void>(resolve=>setImmediate(resolve));throw Error('synthetic serializer refusal');}finally{serializerSettled=true;}}}));
  const changes=f.sqlite.prepare('SELECT total_changes() n').get()!.n;
  await assert.rejects(measureProspectiveRecoverability(f.db,owner,{now}),/Current normalized content hash differs/);
  assert.equal(serializerSettled,true,'no pending serializer escapes the closed hash context');assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,0);
 }finally{f.sqlite.close();}
});

for(const invalid of ['shape','overflow'] as const)test('physical '+invalid+' refusal never starts an export adapter',async t=>{
 const f=await fixture();try{
  if(invalid==='shape')f.sqlite.prepare('UPDATE evidence_records SET content_hash=? WHERE user_id=?').run('invalid-digest',owner);
  else f.sqlite.prepare('UPDATE evidence_records SET payload_json=? WHERE user_id=?').run(JSON.stringify({text:'x'.repeat(BUNDLE_LIMITS.bytes)}),owner);
  let exports=0;const entries=exportRegistry.entries.bind(exportRegistry);t.mock.method(exportRegistry,'entries',()=>entries().map(item=>({...item,async exportRows(context:ExportContext){exports++;return item.exportRows(context);}})));
  await assert.rejects(measureProspectiveRecoverability(f.db,owner,{now}));assert.equal(exports,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,0);
 }finally{f.sqlite.close();}
});
