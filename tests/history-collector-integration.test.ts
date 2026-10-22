import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readHistoryRecord,listHistoryRecords} from '../lib/history/store.ts';
import {enrollHistoryIngestCredential} from '../lib/history/auth.ts';
import {handleHistoryTransport} from '../lib/history/http.ts';
import type {PrivateHistoryBucket} from '../lib/history/object-store.ts';
import type {PrivateIngressVerifier} from '../lib/devices/contracts.ts';
import {createTransport} from '../collector/src/transport.mjs';
import {runCollector} from '../collector/src/cli.mjs';
const owner='synthetic-collector-http-owner',sourceId='synthetic-source',origin='https://example.invalid';
/** Actual reader, CLI, durable spool, client transport and server HTTP/store paths.
 * Memory bucket and private-ingress verifier are synthetic ports: no R2, hosted
 * ingress, physical device, provider authentication or owner roots are verified. */
async function fixture(messageCount=251){
 const directory=await mkdtemp(join(tmpdir(),'synthetic-collector-integration-')),{db,sqlite}=database(),now=()=>new Date().toISOString(),root=join(directory,'root'),state=join(directory,'state');
 try{
  await mkdir(root,{mode:0o700});
  const records:unknown[]=[{type:'session_meta',payload:{id:'synthetic-thread'}}];
  for(let i=0;i<messageCount;i++)records.push({type:'response_item',payload:{type:'message',id:'synthetic-'+i,role:'user',content:[{type:'input_text',text:'synthetic retained content '+i}]}});
  await writeFile(join(root,'retained.jsonl'),records.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await loadWorkspace(db,owner,()=>workspaceFixture(),now());
  const configured=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'history.source.configure',sourceId,expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic fixture',roots:[root],accountId:null,deviceId:null,includeArchived:true,exclusions:[]}},{db,now,handlers:workspaceHandlers});
  assert.equal(configured.status,'committed');
  const source=(await readHistoryRecord(db,owner,'source',sourceId))!.record.value.configuration;
  const enrollment=await enrollHistoryIngestCredential(db,{authenticatedOwnerId:owner,authorizeOwner:async()=>true},{sourceId,expiresAt:new Date(Date.now()+3600000).toISOString()},now());
  const objects=new Map<string,Uint8Array>(),counts={uploads:0,metadata:0,ingress:0};let revokeOnPut=false;
  const bucket:PrivateHistoryBucket={async put(key,bytes){objects.set(key,bytes.slice());if(revokeOnPut)await db.prepare('UPDATE history_ingest_credentials SET revoked_at=? WHERE user_id=?').bind(now(),owner).run();},async get(key,maxBytes){const bytes=objects.get(key);if(bytes&&bytes.byteLength>maxBytes)throw Error('Synthetic bucket read exceeds declared bound.');return bytes?.slice()??null;},async delete(key){objects.delete(key);}};
  const privateIngress:PrivateIngressVerifier={async verify(){counts.ingress++;return {serviceIdentity:'synthetic-private-ingress'};}};
  const services={db,now,bucket,privateIngress};
  const transportOptions={origin,allowedOrigins:[origin],credential:async()=>({...enrollment,sourceId,epoch:source.epoch,scopeRevision:source.scopeRevision}),privateIngress:async()=>({Authorization:'synthetic-gateway-proof'}),fetchImpl:(async(url:RequestInfo|URL,input?:RequestInit)=>{const operation=String(url).endsWith('/objects')?'objects':'ingest';if(operation==='objects')counts.uploads++;else counts.metadata++;return handleHistoryTransport(operation,new Request(url,input),services);}) as typeof fetch};
  // The JS default ingress provider infers Promise<void>; this fixture supplies
  // its documented synthetic header-provider port without changing production.
  const transport=(createTransport as unknown as (options:typeof transportOptions)=>ReturnType<typeof createTransport>)(transportOptions);
  const configuration={codecVersion:1,origin,stateDirectory:state,sources:[source],scopes:['history.read','history.ingest'],reconcileIntervalMs:1000,debounceMs:0,maxCatchUpLagMs:1000};
  const runOptions={once:true,signal:new AbortController().signal,adapterFactory:undefined,transport,now:Date.now};
  const run=()=>runCollector(configuration,runOptions);
  return {db,sqlite,objects,counts,run,revokeDuringPut:()=>{revokeOnPut=true;},cleanup:async()=>{sqlite.close();await rm(directory,{recursive:true,force:true});}};
 }catch(error){sqlite.close();await rm(directory,{recursive:true,force:true});throw error;}
}
test('synthetic CLI through actual history HTTP and SQLite imports 251 messages, repeats without uploads and retains first immutable metadata',{timeout:120000},async()=>{
 const f=await fixture();try{
  assert.equal((await f.run()).pending,0);
  assert.equal(f.counts.uploads,252);assert.equal(f.counts.metadata,2);assert.equal(f.objects.size,252);
  const firstPage=await listHistoryRecords(f.db,owner,'message',{limit:200}),remaining=await listHistoryRecords(f.db,owner,'message',{limit:200,after:firstPage.at(-1)!.record.id});
  assert.equal(firstPage.length,200);assert.equal(remaining.length,51);const initial=[...firstPage,...remaining];
  assert.equal((await listHistoryRecords(f.db,owner,'segment')).length,1);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,2);
  assert.equal((await f.run()).pending,0);
  assert.equal(f.counts.uploads,252);assert.equal(f.objects.size,252);assert.equal(f.counts.metadata,4);
  const secondFirst=await listHistoryRecords(f.db,owner,'message',{limit:200}),secondRest=await listHistoryRecords(f.db,owner,'message',{limit:200,after:secondFirst.at(-1)!.record.id});
  assert.deepEqual([...secondFirst,...secondRest],initial);
  assert.equal((await listHistoryRecords(f.db,owner,'segment')).length,1);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,4);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").bind(owner).first<{n:number}>())!.n,4);
  assert.equal((await f.db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,2);
  assert.equal((await listHistoryRecords(f.db,'synthetic-foreign-owner','message')).length,0);assert.equal(f.counts.ingress,256);
 }finally{await f.cleanup();}
});
test('synthetic credential revocation during a physical bucket PUT prevents object finalization and every metadata acknowledgement',{timeout:120000},async()=>{
 const f=await fixture(1);try{
  f.revokeDuringPut();await assert.rejects(f.run(),/reconcile_needed|credential_or_ingress_denied/);
  assert.equal(f.counts.uploads,1);assert.equal(f.counts.metadata,0);assert.equal(f.objects.size,1);
  const ledger=(await f.db.prepare('SELECT status,pending_token FROM history_object_ledger WHERE user_id=?').bind(owner).all<{status:string;pending_token:string|null}>()).results;
  assert.deepEqual(ledger.map(row=>({...row})),[{status:'abandoned',pending_token:null}]);
  assert.equal((await listHistoryRecords(f.db,owner,'message')).length,0);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,0);assert.equal((await listHistoryRecords(f.db,owner,'cursor')).length,0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").bind(owner).first<{n:number}>())!.n,0);
  assert.equal((await f.db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,2);
 }finally{await f.cleanup();}
});
