import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceExportAdapters} from '../lib/sources/module.ts';
import {runtimeExportAdapters} from '../lib/runtime/module.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {createServerSerializationHashContext} from '../lib/server/serialization-hash.ts';
import {closeSerializationHashContext} from '../lib/serialization-hash.ts';
import {ownerReader,type RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import {moduleColumnNames,moduleProjection} from '../lib/module-columns.ts';
import {loadWorkspace,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
import type {ExportContext,ExportModule} from '../lib/workspace-export.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {runtimePortableFixture,runtimePortableNow as now} from './fixtures/runtime/portable.ts';
const owner='synthetic-verifier-owner',foreign='synthetic-verifier-foreign';
const adapters=[...sourceExportAdapters,...runtimeExportAdapters];
async function fixture(){
 const db=database(),runtime=await runtimePortableFixture(),project=workspaceFixture().projects[0].id;
 await loadWorkspace(db.db,owner,workspaceFixture,now);await loadWorkspace(db.db,foreign,workspaceFixture,now);
 const connection={id:'synthetic-source-connection',provider:'github',label:'Literal العربية 😀 é',accessMode:'interactive',enabled:true,archivedAt:null};
 const target={id:'synthetic-source-target',connectionId:connection.id,projectId:project,kind:'github_repository',providerResourceId:'synthetic/repository',canonicalUrl:'https://github.com/synthetic/repository',selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null};
 const values=new Map<RegisteredOwnerTable,JsonValue>([['source_connections',connection],['source_targets',target],['devices',runtime.device as unknown as JsonValue],['runtime_adapter_configurations',runtime.configuration as unknown as JsonValue]]);
 async function insert(table:RegisteredOwnerTable,value:JsonValue,user=owner){const id=(value as {id:string}).id,columns=moduleColumnNames(table),projection=await moduleProjection(table,id,value),hash=await contentHash(canonical(value));db.sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash${columns.map(c=>','+c).join('')}) VALUES(?,?,1,?,?${columns.map(()=>',?').join('')})`).run(user,id,JSON.stringify(value,null,2),hash,...columns.map(c=>projection[c]));return hash;}
 for(const [table,value]of values){await insert(table,value);await insert(table,value,foreign);}
 return {db,values,insert};
}
function context(db:SqlDatabase,user:string,serializationHashContext:ExportContext['serializationHashContext']):ExportContext{return {db,userId:user,sourceRevision:1,query:ownerReader(db,user),serializationHashContext};}
for(const table of ['source_connections','source_targets','devices','runtime_adapter_configurations'] as const){
 test(`${table} exporter uses exact genuine context digest, keeps claimed hash comparison and owner scope`,async t=>{
  const f=await fixture(),adapter=adapters.find(a=>a.key===table)!,value=f.values.get(table)!,id=(value as {id:string}).id,hash=await contentHash(canonical(value)),native=crypto.subtle.digest.bind(crypto.subtle);let webCalls=0;
  t.mock.method(crypto.subtle,'digest',(...args:Parameters<typeof crypto.subtle.digest>)=>{webCalls++;return native(...args);});
  const operation=createServerSerializationHashContext();
  try{
   const expected=[{id,rowRevision:1,contentHash:hash,value}];assert.deepEqual(await adapter.exportRows(context(f.db.db,owner,operation)),expected);assert.deepEqual(await adapter.exportRows(context(f.db.db,owner,operation)),expected);assert.equal(webCalls,0,'both exports use the fixed native/context route');
   assert.deepEqual(await adapter.exportRows(context(f.db.db,'missing-owner',operation)),[]);
   f.db.sqlite.prepare(`UPDATE ${table} SET content_hash=? WHERE user_id=?`).run('f'.repeat(64),owner);
   await assert.rejects(adapter.exportRows(context(f.db.db,owner,operation)),/digest/,'a cached genuine digest still compares every row claimed hash');
   f.db.sqlite.prepare(`UPDATE ${table} SET content_hash=?,payload_json=? WHERE user_id=?`).run(hash,canonical({...value as object,id:'changed-physical-id'}),owner);
   await assert.rejects(adapter.exportRows(context(f.db.db,owner,operation)),/identity/);
   const foreignOperation=createServerSerializationHashContext();try{assert.deepEqual(await adapter.exportRows(context(f.db.db,foreign,foreignOperation)),expected,'corrupt owner rows never contaminate same-ID foreign rows');}finally{closeSerializationHashContext(foreignOperation);}
  }finally{closeSerializationHashContext(operation);f.db.sqlite.close();}
 });
 test(`${table} same-revision payload/hash mutation after physical capture cannot pass final reread`,async()=>{
  const f=await fixture(),value=f.values.get(table)!,changed={...value as object,...(table==='source_targets'?{providerResourceId:'synthetic/changed'}:table==='runtime_adapter_configurations'?{selectedGpuAlias:'changed'}:{label:'changed'})} as JsonValue,changedHash=await contentHash(canonical(changed)),queries=new WeakMap<SqlStatement,string>();let changedOnce=false;
  const observed:SqlDatabase={prepare(sql){const statement=f.db.db.prepare(sql);queries.set(statement,sql);return statement;},async batch(statements){const result=await f.db.db.batch(statements);if(!changedOnce&&statements.some(statement=>queries.get(statement)?.startsWith('WITH recovery_page_scope'))){changedOnce=true;f.db.sqlite.prepare(`UPDATE ${table} SET payload_json=?,content_hash=? WHERE user_id=?`).run(canonical(changed),changedHash,owner);}return result;}};
  try{await assert.rejects(measureProspectiveRecoverability(observed,owner,{now}),/Normalized row set changed/);assert.equal(changedOnce,true);assert.equal(f.db.sqlite.prepare(`SELECT row_revision FROM ${table} WHERE user_id=?`).get(owner)!.row_revision,1);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);}finally{f.db.sqlite.close();}
 });
}

test('nested source/runtime payload digests remain independently verified through the same server context',async()=>{
 const runtime=await runtimePortableFixture(),payload={text:'Literal العربية 😀'},observation={id:'synthetic-observation',sourceId:'synthetic-source-target',externalId:'external',sourceRevision:'v1',sourceUpdatedAt:null,observedAt:now,title:'Source',canonicalUrl:null,contentDigest:'f'.repeat(64),payload,origin:'provider-read'};
 const examples:[[ExportModule,JsonValue],[ExportModule,JsonValue]]=[[sourceExportAdapters.find(a=>a.key==='source_observations')!,observation],[runtimeExportAdapters.find(a=>a.key==='runtime_evidence')!,{...runtime.evidence,payloadHash:'f'.repeat(64)} as unknown as JsonValue]];
 for(const [adapter,value]of examples){const hash=await contentHash(canonical(value)),operation=createServerSerializationHashContext(),row={id:(value as {id:string}).id,row_revision:1,payload_json:canonical(value),content_hash:hash};
  const ctx={serializationHashContext:operation,query:{async list(){return [row];}}} as unknown as ExportContext;
  try{await assert.rejects(adapter.exportRows(ctx),/digest/);}finally{closeSerializationHashContext(operation);}
 }
});
