import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace } from '../lib/workspace-store.ts';
import { exportWorkspaceBundle, ExportRegistry, ownerExportModule, parseWorkspaceBundle, historicalAuditRows, assertPortable } from '../lib/workspace-export.ts';
const now='2026-10-18T12:00:00.000Z';
test('owner-scoped bounded normalized rows and hashes, no receipt/job authority',async()=>{
 const {db,sqlite}=database(); await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);await loadWorkspace(db,'b',()=>createSeedWorkspace(now),now);
 for(const owner of ['a','b'])for(let n=0;n<205;n++)sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,1,?,?)').run(owner,String(n).padStart(4,'0'),JSON.stringify({text:owner}),'a'.repeat(64));
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
 const {db,sqlite}=database();await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);sqlite.prepare('INSERT INTO workspace_configuration (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,1,?,?)').run('a','decision','{}','hash');await assert.rejects(exportWorkspaceBundle(db,'a'),/no export adapter/);sqlite.close();
});
test('owner revision races retry; module versions, authority module names, and row bounds fail closed',async()=>{
 const {db,sqlite}=database();await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);let calls=0;const registry=new ExportRegistry();registry.register({key:'fixture',schemaVersion:1,policy:'replace',exportRows:async()=>{if(calls++===0)sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run('a');return [];},parseAndMigrate:input=>{if(input.schemaVersion!==1)throw new Error('Unknown module version.');return input.records;}});
 const bundle=await exportWorkspaceBundle(db,'a',{registry});assert.equal(bundle.source.workspaceRevision,2);assert.equal(calls,4);
 assert.throws(()=>parseWorkspaceBundle({...bundle,modules:{fixture:{schemaVersion:2,records:[]}}},registry),/version/);
 assert.throws(()=>registry.register({key:'workspace_job_intents',schemaVersion:1,policy:'replace',exportRows:async()=>[],parseAndMigrate:i=>i.records}));
 const excessive=new ExportRegistry();excessive.register({key:'fixture',schemaVersion:1,policy:'replace',exportRows:async()=>Array.from({length:10001},(_,id)=>({id:String(id)})),parseAndMigrate:i=>i.records});await assert.rejects(exportWorkspaceBundle(db,'a',{registry:excessive}),/row limit/);sqlite.close();
});
test('portable audit actor metadata excludes authenticated owner identities including nested historical claims',async()=>{
 const {db,sqlite}=database();const authenticatedOwner='synthetic-authenticated-owner-private-id';await loadWorkspace(db,authenticatedOwner,()=>createSeedWorkspace(now),now);
 sqlite.prepare('INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES (?,?,1,0,NULL,NULL,?,?,NULL,?,?)').run(authenticatedOwner,'event','fixture','workspace',now,JSON.stringify({id:'event',actorId:authenticatedOwner,changes:[{sourceClaim:{actorId:authenticatedOwner}}]}));
 const bundle=await exportWorkspaceBundle(db,authenticatedOwner);assert.ok(!JSON.stringify(bundle).includes(authenticatedOwner));assert.match(JSON.stringify(bundle.modules.audit_events),/"actorId":"owner"/);assert.ok((sqlite.prepare('SELECT payload_json FROM audit_events WHERE user_id=?').get(authenticatedOwner)!.payload_json as string).includes(authenticatedOwner));sqlite.close();
});
test('strict bundle metadata rejects unknown fields, malformed hashes, wrappers and authority payload keys',async()=>{
 const {db,sqlite}=database();await loadWorkspace(db,'a',()=>createSeedWorkspace(now),now);const base=await exportWorkspaceBundle(db,'a');
 for(const bad of [{...base,credentials:'private'},{...base,source:{...base.source,other:'private'}},{...base,source:{...base.source,credentials:'private'}},{...base,source:{...base.source,sourceHashes:{planning:'malformed'}}},{...base,source:{...base.source,moduleWatermarks:{unknown:'a'.repeat(64)}}},{...base,modules:{audit_events:{schemaVersion:1,records:[],credentials:'private'}}},{...base,completeness:'verified'},{...base,attachments:[{id:'unsupported'}]}])assert.throws(()=>parseWorkspaceBundle(bad));
 const adapter=ownerExportModule('evidence_records',()=>{});const valid={id:'row',rowRevision:1,contentHash:'a'.repeat(64),value:{text:'safe'}};
 assert.deepEqual(adapter.parseAndMigrate({schemaVersion:1,records:[valid]}),[valid]);
 for(const bad of [{...valid,credentials:'private'},{...valid,other:'private'},{...valid,rowRevision:0},{...valid,rowRevision:1.5},{...valid,id:'x'.repeat(129)},{...valid,contentHash:'invalid'},{...valid,value:{accessToken:'private'}},{...valid,value:{executionApproval:'grant'}}])assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[bad]}));
 sqlite.close();
});
