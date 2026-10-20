import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeExportAdapters,runtimeReferenceDescriptors,validateRuntimeModuleReferences} from '../lib/runtime/module.ts';
import {runtimePortableFixture,portableRuntimeRow,runtimePortableNow} from './fixtures/runtime/portable.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {canonicalJsonValue} from '../lib/audit-events.ts';
import {database} from './helpers/sqlite.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import type {ExportContext} from '../lib/workspace-export.ts';
import type {RuntimeAdapterConfiguration,SelectedRuntimeEvidence} from '../lib/runtime/contracts.ts';
const adapter=(key:string)=>runtimeExportAdapters.find(value=>value.key===key)!;
test('portable selected evidence preserves exact IDs, original bytes/hashes and unknowns; import disables adapters and retains historical provenance only',async()=>{
 const f=await runtimePortableFixture(),before=canonical(f.context);validateRuntimeModuleReferences(f.context);
 assert.deepEqual(runtimeExportAdapters.map(value=>value.key),['devices','runtime_adapter_configurations','runtime_evidence']);
 for(const value of runtimeExportAdapters){assert.equal(value.legacyOptional,true);const parsed=value.parseAndMigrate(f.context.modules[value.key]);assert.deepEqual(parsed,f.context.modules[value.key].records);const physical=await value.prepareReplace!(f.context,parsed);assert.equal(physical.length,1);assert.equal(physical[0].table,value.key);assert.deepEqual(physical[0].records.map(row=>row.id),parsed.map(row=>(row as {id:string}).id));
  if(value.key==='runtime_adapter_configurations'){const restored=physical[0].records[0].value as unknown as RuntimeAdapterConfiguration;assert.equal(restored.manifest.enabled,false);assert.deepEqual(restored,{...f.configuration,manifest:{...f.configuration.manifest,enabled:false}});}
  if(value.key==='runtime_evidence'){const restored=physical[0].records[0].value as unknown as SelectedRuntimeEvidence;assert.deepEqual(restored,{...f.evidence,origin:'historical-import'});assert.equal(restored.observedAt,null);assert.equal(restored.observation.metrics!.cpuPercent,0);assert.equal(restored.observation.metrics!.gpuUtilizationPercent,null);assert.equal(restored.payloadHash,await contentHash(canonical(restored.observation)));assert.deepEqual(restored.heartbeatRef,f.evidence.heartbeatRef);}
  assert.deepEqual(await value.prepareReplace!({...f.context,modules:{}},[]),[{table:value.key,records:[]}]);
 }
 assert.equal(canonical(f.context),before);
 for(const forbidden of ['device_credentials','device_runtime','device_sessions','device_live_windows','device_heartbeats','runtime_latest','runtime_observations','runtime_minute_aggregates'])assert.equal(runtimeExportAdapters.some(value=>value.tables?.some(table=>table===forbidden)),false);
});
test('strict wrappers, row limits, unknown versions, private fields and forged immutable digests refuse import',async()=>{
 const f=await runtimePortableFixture();for(const value of runtimeExportAdapters){const input=f.context.modules[value.key],row=input.records[0] as {id:string;value:unknown};assert.throws(()=>value.parseAndMigrate({...input,schemaVersion:2}));assert.throws(()=>value.parseAndMigrate({...input,records:[row,row]}));assert.throws(()=>value.parseAndMigrate({...input,records:[{...row,id:'wrong-physical-id'}]}));assert.throws(()=>value.parseAndMigrate({...input,records:[{...row,ownerId:'foreign'}]}));assert.throws(()=>value.parseAndMigrate({...input,records:[{...row,value:{...(row.value as object),credential:'synthetic-not-a-real-secret'}}]}));await assert.rejects(async()=>value.prepareReplace!(f.context,[{...row,contentHash:'f'.repeat(64)}]));}
 const selected=adapter('runtime_evidence');assert.throws(()=>selected.parseAndMigrate({schemaVersion:1,records:Array.from({length:501},(_,i)=>({id:'over-'+i}))}));
 const bad=await portableRuntimeRow({...f.evidence,payloadHash:'f'.repeat(64)});await assert.rejects(async()=>selected.prepareReplace!(f.context,[bad]),/observation digest/);
 const corrupt=await portableRuntimeRow({...f.evidence,observation:{...f.observation,metrics:{...f.observation.metrics!,cpuPercent:1}}});await assert.rejects(async()=>selected.prepareReplace!(f.context,[corrupt]));
});
test('portable references require exact device/project and unique configured adapter instances without guessing native session authority',async()=>{
 const f=await runtimePortableFixture();assert.throws(()=>validateRuntimeModuleReferences({...f.context,modules:{...f.context.modules,devices:{schemaVersion:1,records:[]}}}));
 const config=adapter('runtime_adapter_configurations');await assert.rejects(async()=>config.prepareReplace!(f.context,[await portableRuntimeRow({...f.configuration,projectId:'missing-project'})]));
 const duplicate=await portableRuntimeRow({...f.configuration,id:'second-same-instance'});assert.throws(()=>validateRuntimeModuleReferences({...f.context,modules:{...f.context.modules,runtime_adapter_configurations:{schemaVersion:1,records:[...f.context.modules.runtime_adapter_configurations.records,duplicate]}}}));
 for(const manifest of [{...f.configuration.manifest,endpointAlias:'http://127.0.0.1/private'},{...f.configuration.manifest,id:'trade-graph',enabled:true},{...f.configuration.manifest,capabilities:['execute']}])assert.throws(()=>config.parseAndMigrate({schemaVersion:1,records:[{...f.context.modules.runtime_adapter_configurations.records[0] as object,value:{...f.configuration,manifest}}]}));
 assert.equal(runtimeReferenceDescriptors.find(value=>value.key==='devices')!.entityKind,'device');
 assert.deepEqual(runtimeReferenceDescriptors.find(value=>value.key==='runtime_evidence')!.references(f.evidence),[{kind:'device',id:f.device.id,path:['deviceId']}]);
 assert.deepEqual(runtimeReferenceDescriptors.find(value=>value.key==='runtime_adapter_configurations')!.references(f.configuration),[{kind:'device',id:f.device.id,path:['deviceId']},{kind:'project',id:'p1',path:['projectId']}]);
});
test('actual owner-scoped SQLite export includes only explicitly selected evidence and display/config, never private runtime authority',async()=>{
 const f=await runtimePortableFixture(),db=database();try{
  for(const value of runtimeExportAdapters)for(const raw of f.context.modules[value.key].records){const row=raw as {id:string;value:unknown;contentHash:string},columns=moduleColumnNames(value.key as 'devices'|'runtime_adapter_configurations'|'runtime_evidence'),projection=await moduleProjection(value.key as 'devices'|'runtime_adapter_configurations'|'runtime_evidence',row.id,canonicalJsonValue(row.value));for(const owner of ['synthetic-a','synthetic-b'])db.sqlite.prepare('INSERT INTO '+value.key+'(user_id,id,row_revision,payload_json,content_hash'+(columns.length?','+columns.join(','):'')+') VALUES(?,?,1,?,?'+(columns.length?','+columns.map(()=>'?').join(','):'')+')').run(owner,row.id,canonical(row.value),row.contentHash,...columns.map(column=>projection[column]));}
  db.sqlite.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').run('synthetic-a','synthetic-private-credential',f.device.id,'e'.repeat(64),'["telemetry:write"]',runtimePortableNow,'2027-01-01T00:00:00.000Z');
  for(const value of runtimeExportAdapters){const context:ExportContext={db:db.db,userId:'synthetic-a',sourceRevision:1,query:ownerReader(db.db,'synthetic-a')};assert.deepEqual(await value.exportRows(context),f.context.modules[value.key].records);assert.deepEqual(await value.exportRows({...context,userId:'unknown-owner',query:ownerReader(db.db,'unknown-owner')}),[]);}
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM device_credentials').get()!.n,1);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM device_sessions').get()!.n,0);
  db.sqlite.prepare('UPDATE runtime_evidence SET content_hash=? WHERE user_id=?').run('f'.repeat(64),'synthetic-a');await assert.rejects(adapter('runtime_evidence').exportRows({db:db.db,userId:'synthetic-a',sourceRevision:1,query:ownerReader(db.db,'synthetic-a')}));
 }finally{db.sqlite.close();}
});
