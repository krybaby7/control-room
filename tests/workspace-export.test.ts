import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace } from '../lib/workspace-store.ts';
import { exportWorkspaceBundle, ExportRegistry, ownerExportModule, parseWorkspaceBundle, historicalAuditRows, assertPortable } from '../lib/workspace-export.ts';
const now='2026-10-18T12:00:00.000Z';
test('owner-scoped bounded normalized rows and hashes, no receipt/job authority',async()=>{
 const {db,sqlite}=database(); await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);await loadWorkspace(db,'b',()=>createSeedWorkspace(now),now);
 for(const owner of ['a','b'])for(let n=0;n<205;n++)sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,1,?,?)').run(owner,String(n).padStart(4,'0'),JSON.stringify({text:owner}),'hash');
 const registry=new ExportRegistry();registry.register(ownerExportModule('evidence_records',()=>{})); const bundle=await exportWorkspaceBundle(db,'a',{registry});
 assert.equal(bundle.modules.evidence_records.records.length,205);assert.ok(JSON.stringify(bundle.modules).includes('"a"'));assert.ok(!JSON.stringify(bundle.modules).includes('"b"'));assert.equal(bundle.source.sourceHashes.evidence_records.length,64);assert.ok(!('workspace_mutations'in bundle.modules));
 sqlite.close();
});
test('module race retries and sustained race fails closed',async()=>{
 const {db,sqlite}=database();await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);let calls=0;const registry=new ExportRegistry();registry.register({key:'fixture',schemaVersion:1,policy:'replace',exportRows:async()=>[{id:String(calls++)}],parseAndMigrate:i=>i.records});
 await assert.rejects(exportWorkspaceBundle(db,'a',{registry}),/changed/);assert.equal(calls,6);sqlite.close();
});
test('unknown modules and unsafe payloads fail closed; audit provenance is append-only data',async()=>{
 const {db,sqlite}=database();await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);const bundle=await exportWorkspaceBundle(db,'a');
 assert.throws(()=>parseWorkspaceBundle({...bundle,modules:{unknown:{schemaVersion:1,records:[]}}}),/Unknown/);
 assert.throws(()=>parseWorkspaceBundle({...bundle,bundleVersion:2}),/version/);assert.throws(()=>assertPortable({token:'no'}));
 bundle.modules.audit_events.records=[{id:'source',actorId:'untrusted'}];const rows=historicalAuditRows(bundle,'a'.repeat(64)) as {id:string;sourceClaim:unknown}[];assert.match(rows[0].id,/^import:/);assert.deepEqual(rows[0].sourceClaim,bundle.modules.audit_events.records[0]);sqlite.close();
});
test('populated unregistered owner modules cannot be silently omitted',async()=>{
 const {db,sqlite}=database();await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);sqlite.prepare('INSERT INTO decisions (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,1,?,?)').run('a','decision','{}','hash');await assert.rejects(exportWorkspaceBundle(db,'a'),/no export adapter/);sqlite.close();
});
test('owner revision races retry; module versions, authority module names, and row bounds fail closed',async()=>{
 const {db,sqlite}=database();await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);let calls=0;const registry=new ExportRegistry();registry.register({key:'fixture',schemaVersion:1,policy:'replace',exportRows:async()=>{if(calls++===0)sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run('a');return [];},parseAndMigrate:input=>{if(input.schemaVersion!==1)throw new Error('Unknown module version.');return input.records;}});
 const bundle=await exportWorkspaceBundle(db,'a',{registry});assert.equal(bundle.source.workspaceRevision,2);assert.equal(calls,4);
 assert.throws(()=>parseWorkspaceBundle({...bundle,modules:{fixture:{schemaVersion:2,records:[]}}},registry),/version/);
 assert.throws(()=>registry.register({key:'workspace_job_intents',schemaVersion:1,policy:'replace',exportRows:async()=>[],parseAndMigrate:i=>i.records}));
 const excessive=new ExportRegistry();excessive.register({key:'fixture',schemaVersion:1,policy:'replace',exportRows:async()=>Array.from({length:10001},(_,id)=>({id:String(id)})),parseAndMigrate:i=>i.records});await assert.rejects(exportWorkspaceBundle(db,'a',{registry:excessive}),/row limit/);sqlite.close();
});
