import {createSerializationHashContext,closeSerializationHashContext} from '../lib/serialization-hash.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {evidenceExportAdapters,validateEvidenceModuleReferences} from '../lib/evidence-module.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {portableHeadId,versionRowId} from '../lib/version-identity.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-composite-owner',other='synthetic-foreign-owner';
type DigestArgs=Parameters<typeof crypto.subtle.digest>;
async function fixture(count=256){
 const f=database();for(const id of [owner,other])await loadWorkspace(f.db,id,workspaceFixture,now);
 const expected:unknown[]=[],versions:Array<{key:string;value:Record<string,unknown>}>=[],heads=f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash,current_version) VALUES(?,?,3,?,?,1)'),insert=f.sqlite.prepare('INSERT INTO evidence_versions(user_id,id,row_revision,payload_json,content_hash,evidence_id,version,recorded_at) VALUES(?,?,3,?,?,?,1,?)');
 for(let index=0;index<count;index++){
  const logical='original/العربية😀:'+String(index).padStart(4,'0'),head={id:logical,currentVersion:1,archivedAt:null},version={id:logical,version:1,basis:'owner-statement',scope:'implementation',title:'Original exact evidence',statement:'Original Unicode é / bytes '+index,observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null},key=await versionRowId(logical,1);
  heads.run(owner,logical,canonical(head),await contentHash(canonical(head)));insert.run(owner,key,canonical(version),await contentHash(canonical(version)),logical,now);versions.push({key,value:version});
  for(const [kind,physicalId,record,id]of [['head',logical,head,await portableHeadId(logical)],['version',key,version,key]]as const){const value={kind,physicalId,record};expected.push({id,rowRevision:3,contentHash:await contentHash(canonical(value)),value});}
 }
 const logical='foreign-original',head={id:logical,currentVersion:1,archivedAt:null},version={id:logical,version:1,basis:'owner-statement',scope:'implementation',title:'Foreign owner record',statement:'Must stay with foreign owner',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
 heads.run(other,logical,canonical(head),await contentHash(canonical(head)));insert.run(other,await versionRowId(logical,1),canonical(version),await contentHash(canonical(version)),logical,now);
 const adapter=evidenceExportAdapters.find(value=>value.key==='evidence')!;assert.ok(adapter);
 const context=(userId=owner)=>({userId,sourceRevision:1,query:ownerReader(f.db,userId),db:f.db});
 return {...f,expected:expected.sort((a,b)=>(a as {id:string}).id.localeCompare((b as {id:string}).id)),versions,adapter,context};
}
test('actual SQLite512-row composite export checks every native identity/hash with at most32 active digests and exact original provenance',async context=>{
 const f=await fixture();try{
  const original=crypto.subtle.digest.bind(crypto.subtle),before=f.sqlite.prepare('SELECT * FROM evidence_versions ORDER BY user_id,id').all(),workspace=await readCurrent(f.db,owner,now);let calls=0,active=0,maximum=0;
  context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;maximum=Math.max(maximum,active);return original(...args).finally(()=>{active--;});});
  const rows=await f.adapter.exportRows(f.context());assert.equal(calls,1536,'portable ID + canonical payload SHA + exact identity are all verified for all512 rows');assert.equal(maximum,32);assert.equal(active,0);assert.deepEqual(rows,f.expected);
  assert.equal(JSON.stringify(rows).includes('Must stay with foreign owner'),false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);assert.deepEqual(await readCurrent(f.db,owner,now),workspace);assert.deepEqual(f.sqlite.prepare('SELECT * FROM evidence_versions ORDER BY user_id,id').all(),before);
  const modules=Object.fromEntries(evidenceExportAdapters.map(adapter=>[adapter.key,{schemaVersion:1,records:adapter.key==='evidence'?rows:[]}]));
  validateEvidenceModuleReferences({planning:workspace.workspace,modules});
  const foreign=await f.adapter.exportRows(f.context(other));assert.equal(foreign.length,2);assert.ok(JSON.stringify(foreign).includes('Must stay with foreign owner'));assert.equal(calls,1542);assert.equal(active,0);
  assert.deepEqual(await f.adapter.exportRows(f.context()),f.expected);assert.equal(calls,3078,'same-owner later calls do not reuse a hash cache');assert.equal(active,0);
 }finally{f.sqlite.close();}
});
test('a late invalid native version settles every other worker and cannot produce a partial successful export',async context=>{
 const f=await fixture(40);try{
  const selected=f.versions[39],invalid={...selected.value,version:0};f.sqlite.prepare('UPDATE evidence_versions SET payload_json=? WHERE user_id=? AND id=?').run(canonical(invalid),owner,selected.key);
  const original=crypto.subtle.digest.bind(crypto.subtle);let active=0;
  context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{active++;return original(...args).finally(()=>{active--;});});
  await assert.rejects(f.adapter.exportRows(f.context()));assert.equal(active,0);assert.equal(f.sqlite.prepare('SELECT payload_json FROM evidence_versions WHERE user_id=? AND id=?').get(owner,selected.key)!.payload_json,canonical(invalid),'refusal never repairs the original stored row');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('ordered asynchronous physical-identity failure wins over a later synchronous JSON failure and all digests settle',async context=>{
 const f=await fixture(40);try{
  const first=f.versions[0],last=f.versions[39];
  // Explicit synthetic corruption of original native rows, not an owner write command.
  f.sqlite.prepare('UPDATE evidence_versions SET id=? WHERE user_id=? AND id=?').run('000-corrupt-physical-key',owner,first.key);
  f.sqlite.prepare('UPDATE evidence_versions SET id=?,payload_json=? WHERE user_id=? AND id=?').run('zzz-corrupt-original-json','not original JSON',owner,last.key);
  const original=crypto.subtle.digest.bind(crypto.subtle);let active=0,maximum=0;
  context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{active++;maximum=Math.max(maximum,active);return original(...args).finally(()=>{active--;});});
  await assert.rejects(f.adapter.exportRows(f.context()),/Version physical identity differs/);assert.ok(maximum<=32);assert.equal(active,0);assert.equal(f.sqlite.prepare('SELECT id FROM evidence_versions WHERE user_id=? AND id=?').get(owner,'000-corrupt-physical-key')!.id,'000-corrupt-physical-key');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}
});

test('explicit operation-local serialization context reuses exact native digests across exports without reusing owner rows or skipping validation',async context=>{
 const f=await fixture();const scope=createSerializationHashContext(),otherScope=createSerializationHashContext();
 try{
  const native=crypto.subtle.digest.bind(crypto.subtle);let calls=0,active=0;
  context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;return native(...args).finally(()=>{active--;});});
  const selected={...f.context(),serializationHashContext:scope};
  assert.deepEqual(await f.adapter.exportRows(selected),f.expected);assert.equal(calls,768,'256 logical IDs plus512 exact wrapper strings, all genuine native SHA');assert.equal(active,0);
  assert.deepEqual(await f.adapter.exportRows(selected),f.expected);assert.equal(calls,768,'same operation may reuse digests, but schema/identity comparisons still execute');
  assert.deepEqual(await f.adapter.exportRows({...f.context(),serializationHashContext:otherScope}),f.expected);assert.equal(calls,1536,'a later operation gets no previous digests');
  const corrupt=f.versions[39];f.sqlite.prepare('UPDATE evidence_versions SET id=? WHERE user_id=? AND id=?').run('000-corrupt-cached-physical',owner,corrupt.key);
  await assert.rejects(f.adapter.exportRows(selected),/Version physical identity differs/);assert.equal(active,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{closeSerializationHashContext(scope);closeSerializationHashContext(otherScope);f.sqlite.close();}
});
test('cached serialization still chooses earliest original row failure and waits for all native workers to settle',async context=>{
 const f=await fixture(40),scope=createSerializationHashContext();try{
  await f.adapter.exportRows({...f.context(),serializationHashContext:scope});
  const first=f.versions[0],last=f.versions[39];
  f.sqlite.prepare('UPDATE evidence_versions SET id=? WHERE user_id=? AND id=?').run('000-corrupt-physical-key',owner,first.key);
  f.sqlite.prepare('UPDATE evidence_versions SET id=?,payload_json=? WHERE user_id=? AND id=?').run('zzz-corrupt-original-json','not original JSON',owner,last.key);
  const native=crypto.subtle.digest.bind(crypto.subtle);let active=0,settled=0;
  context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{active++;return native(...args).finally(()=>{active--;settled++;});});
  await assert.rejects(f.adapter.exportRows({...f.context(),serializationHashContext:scope}),/Version physical identity differs/);
  assert.equal(active,0);assert.ok(settled>0,'changed physical wrapper is actually hashed before its identity comparison rejects');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{closeSerializationHashContext(scope);f.sqlite.close();}
});
