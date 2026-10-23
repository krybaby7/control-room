import test from 'node:test';
import type {IngestReceipt} from '../lib/history/contracts.ts';
import type {HistoryObjectManifest} from '../lib/history/object-store.ts';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId} from '../lib/history/record.ts';
import {enrollHistoryIngestCredential} from '../lib/history/auth.ts';
import {handleHistoryTransport,readHistoryTransportBytes} from '../lib/history/http.ts';
import type {PrivateIngressVerifier} from '../lib/devices/contracts.ts';
const now='2026-10-22T00:00:00.000Z',owner='synthetic-http-owner';
const privateIngress:PrivateIngressVerifier={async verify(){return {serviceIdentity:'synthetic-private-ingress'};}};
async function fixture(){
 const {db,sqlite}=database();await loadWorkspace(db,owner,()=>workspaceFixture(),now);
 const sourceId='synthetic-source',id=await historyRecordId('source',sourceId),configuration={codecVersion:1,sourceId,kind:'codex_local',epoch:'epoch',scopeRevision:1,roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'v1',normalizationVersion:'unicode-v1'},value={id:sourceId,configuration,capability:{sourceId,kind:'codex_local',scopeLabel:'Synthetic',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:null},epoch:'epoch',scopeRevision:1,executionEpoch:0,paused:false,removedAt:null},payload=canonical({id,kind:'source',value});
 await db.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(owner,id,payload,await contentHash(payload)).run();
 const enrollment=await enrollHistoryIngestCredential(db,{authenticatedOwnerId:owner,authorizeOwner:async()=>true},{sourceId,expiresAt:'2026-10-22T01:00:00.000Z'},now),bytes=new Map<string,Uint8Array>(),bucket={async put(key:string,data:Uint8Array){bytes.set(key,data.slice());},async get(key:string){return bytes.get(key)??null;},async delete(key:string){bytes.delete(key);}},services={db,bucket,privateIngress,now:()=>now};
 const page={protocolVersion:1,epoch:'epoch',scopeRevision:1,page:{codecVersion:1,sourceId,runId:'run',pageId:'page',previousCursor:null,nextCursor:null,inventoryExhausted:true,conversations:[],messages:[],segments:[],attachments:[],gaps:[],objectManifest:[]}};
 const request=(operation:string,body:unknown,headers:Record<string,string>={})=>new Request('https://synthetic.invalid/api/history/'+operation,{method:'POST',headers:{'X-Control-Room-History':enrollment.token,'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
 return {db,sqlite,sourceId,id,enrollment,services,page,request,bytes};
}
test('history HTTP remains closed before verified private ingress and never consumes a token as ingress proof',async()=>{const f=await fixture();try{const result=await handleHistoryTransport('ingest',f.request('ingest',f.page),{...f.services,privateIngress:undefined});assert.equal(result.status,503);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM workspace_job_intents').first<{n:number}>())!.n,0);}finally{f.sqlite.close();}});
test('atomic HTTP acknowledgement is replayed exactly and changed content/scope cannot gain owner authority',async()=>{const f=await fixture();try{
 const first=await handleHistoryTransport('ingest',f.request('ingest',f.page),f.services);assert.equal(first.status,200);const receipt=await first.json() as {receipt:IngestReceipt};assert.deepEqual(await(await handleHistoryTransport('ingest',f.request('ingest',f.page),f.services)).json(),receipt);assert.equal(receipt.receipt.sourceId,f.sourceId);assert.equal(typeof receipt.receipt.pageDigest,'string');
 assert.equal((await handleHistoryTransport('ingest',f.request('ingest',{...f.page,page:{...f.page.page,runId:'changed'}}),f.services)).status,409);
 assert.equal((await handleHistoryTransport('ingest',f.request('ingest',{...f.page,page:{...f.page.page,sourceId:'foreign-source'}}),f.services)).status,403);
 assert.equal((await handleHistoryTransport('ingest',f.request('ingest',{...f.page,ownerId:owner}),f.services)).status,400);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM workspace_job_intents').first<{n:number}>())!.n,1);
 assert.equal((await f.db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,1);
 }finally{f.sqlite.close();}});
test('private object HTTP binds source generation, verifies digest and revocation blocks new writes',async()=>{const f=await fixture();try{
 const data='synthetic 🌱',sha=await contentHash(data),headers={'content-type':'application/octet-stream','X-History-Source':f.sourceId,'X-History-Epoch':'epoch','X-History-Scope-Revision':'1','X-History-SHA256':sha,'X-History-Upload-Id':'upload_'+'1'.repeat(64)};
 const first=await handleHistoryTransport('objects',f.request('objects',data,headers),f.services);assert.equal(first.status,201);const manifest=await first.json() as HistoryObjectManifest;assert.equal(manifest.sha256,sha);assert.equal(manifest.bytes,new TextEncoder().encode(data).length);assert.match(manifest.key,/^history\//);assert.equal(f.bytes.size,1);
 const replay=await handleHistoryTransport('objects',f.request('objects',data,headers),f.services);assert.equal(replay.status,201);assert.deepEqual(await replay.json(),manifest);assert.equal(f.bytes.size,1);
 assert.equal((await handleHistoryTransport('objects',f.request('objects',data,{...headers,'X-History-Epoch':'old'}),f.services)).status,403);
 await f.db.prepare('UPDATE history_ingest_credentials SET revoked_at=? WHERE user_id=?').bind(now,owner).run();assert.equal((await handleHistoryTransport('objects',f.request('objects',data,headers),f.services)).status,401);assert.equal(f.bytes.size,1);
 }finally{f.sqlite.close();}});
test('stream limits reject before buffering an oversized body',async()=>{let cancelled=false;const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(4));},cancel(){cancelled=true;}});await assert.rejects(readHistoryTransportBytes(body,3),/body_limit/);assert.equal(cancelled,true);});
