import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import {versionRowId} from '../lib/version-identity.ts';
import {createServerSerializationHashContext} from '../lib/server/serialization-hash.ts';
import {closeSerializationHashContext,type SerializationHashContext} from '../lib/serialization-hash.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
import {registerRecoverabilityDiagnostics} from '../lib/recoverability-diagnostics.ts';
const now='2026-10-18T12:00:00.000Z';
const evidence={id:'projection-evidence-العربية-😀',version:1,basis:'owner-statement',scope:'implementation',title:'Context',statement:'Original text',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
const decision={id:'projection-decision-العربية-😀',version:1,title:'Choice',question:'Choose?',options:[],selectedOptionId:null,rationale:'',status:'draft',decidedAt:null,reviewOn:null,subjects:[],evidenceRefs:[],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null};
const records=[['evidence_versions',evidence],['decision_versions',decision]] as const;
test('projection receives the genuine operation digest while every schema and physical identity comparison remains mandatory',async t=>{
 const ids=await Promise.all(records.map(([,record])=>versionRowId(record.id,record.version))),expected=await Promise.all(records.map(([table,record],i)=>moduleProjection(table,ids[i],record))),original=nodeCrypto.createHash.bind(nodeCrypto),web=crypto.subtle.digest.bind(crypto.subtle);let nativeCalls=0,webCalls=0;
 t.mock.method(nodeCrypto,'createHash',(...args:Parameters<typeof nodeCrypto.createHash>)=>{nativeCalls++;return original(...args);});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 t.mock.method(crypto.subtle,'digest',(...args:Parameters<typeof crypto.subtle.digest>)=>{webCalls++;return web(...args);});
 const operation=createServerSerializationHashContext();
 try{for(const [index,[table,record]]of records.entries()){
  assert.equal(await versionRowId(record.id,record.version,operation),ids[index]);assert.equal(nativeCalls,index+1);
  assert.deepEqual(await moduleProjection(table,ids[index],record,operation),expected[index]);assert.equal(nativeCalls,index+1,'projection reuses the exact digest already made by this operation');
  await assert.rejects(moduleProjection(table,ids[index].replace(/:1$/u,':2'),record,operation),/physical ID/);
  await assert.rejects(moduleProjection(table,ids[index],{...record,ownerId:'forged'},operation));
 }assert.equal(webCalls,0);}finally{closeSerializationHashContext(operation);}
 await assert.rejects(moduleProjection('evidence_versions',ids[0],evidence,operation),/closed/);
 await assert.rejects(moduleProjection('evidence_versions',ids[0],evidence,{} as SerializationHashContext),/context/);
 await moduleProjection('evidence_versions',ids[0],evidence);assert.equal(webCalls,1,'ordinary projection retains WebCrypto');
 const next=createServerSerializationHashContext();try{await moduleProjection('evidence_versions',ids[0],evidence,next);assert.equal(nativeCalls,3,'new operations compute a new genuine digest');}finally{closeSerializationHashContext(next);}
});

test('actual recoverability future expansion forwards its existing context for both evidence and decision versions',async t=>{
 const f=database(),owner='synthetic-projection-owner';await loadWorkspace(f.db,owner,workspaceFixture,now);
 try{for(const [table,record]of records){for(const [target,id,value]of [[table==='evidence_versions'?'evidence_records':'decision_records',record.id,{id:record.id,currentVersion:1,archivedAt:null}],[table,await versionRowId(record.id,record.version),record]] as const){const projection=await moduleProjection(target,id,value as JsonValue),columns=moduleColumnNames(target);f.sqlite.prepare(`INSERT INTO ${target}(user_id,id,row_revision,payload_json,content_hash${columns.map(c=>','+c).join('')}) VALUES(?,?,1,?,?${columns.map(()=>',?').join('')})`).run(owner,id,canonical(value),await contentHash(canonical(value)),...columns.map(c=>projection[c]));}}
  const logicalIds=new Set(records.map(([,record])=>record.id)),web=crypto.subtle.digest.bind(crypto.subtle);let logicalWebCalls=0,expansionWebCalls=0,inExpansion=false,expansionPhases=0;
  t.mock.method(crypto.subtle,'digest',(...args:Parameters<typeof crypto.subtle.digest>)=>{const input=new TextDecoder().decode(args[1] as Uint8Array);if(logicalIds.has(input))logicalWebCalls++;if(inExpansion)expansionWebCalls++;return web(...args);});
  const stop=registerRecoverabilityDiagnostics(f.db,phase=>{if(phase!=='expandfuture')return;inExpansion=true;expansionPhases++;return ()=>{inExpansion=false;};});
  try{const first=await measureProspectiveRecoverability(f.db,owner,{now}),second=await measureProspectiveRecoverability(f.db,owner,{now});assert.equal(first.measurement.allowed,true);assert.deepEqual(second.measurement,first.measurement);assert.equal(expansionPhases,2);assert.equal(logicalWebCalls,0,'neither future projection falls back to unscoped version identity hashing');assert.equal(expansionWebCalls,2,'only the genuine whole bundle digest remains in each audit-free expansion');}finally{stop();}
 }finally{f.sqlite.close();}
});
