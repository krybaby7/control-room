import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readHistoryRecord,listHistoryRecords} from '../lib/history/store.ts';
import {enqueueHistorySync,readHistorySyncJob,type HistoryRunnerAuthority} from '../lib/history/job-store.ts';
import {handleHistorySyncRequest} from '../lib/history/sync-http.ts';
import {nativeHistorySyncPorts} from '../lib/history/native-sync-ports.ts';
const now='2026-10-22T12:00:00.000Z',owner='synthetic-native-sync';
test('actual HTTP runner uses quota-accounted private pending objects and retires them only after atomic cursor clear',async()=>{
 const f=database();try{await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'history.source.configure',sourceId:'source',expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic retained source',roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[]}},{db:f.db,handlers:workspaceHandlers,now:()=>now});
 const source=(await readHistoryRecord(f.db,owner,'source','source'))!.record.value;
 const authority:HistoryRunnerAuthority={ownerId:owner,sourceId:'source',epoch:source.epoch,scopeRevision:1,principalRef:'synthetic-native-principal',verifiedAt:now,expiresAt:'2026-10-22T13:00:00.000Z',renewable:false,freshProcessReadVerified:false,renewalAndRevocationVerified:false,guardAt:async()=>({sql:'1',bindings:[]})};
 const intent=(await enqueueHistorySync(f.db,{ownerId:owner,sourceId:'source',kind:'history_import',dueAt:now,now,authority}))!;assert.ok(intent);
 const objects=new Map<string,Uint8Array>();let puts=0,deletes=0;const bucket={async put(key:string,bytes:Uint8Array){puts++;objects.set(key,bytes.slice());},async get(key:string,max:number){const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=max);return bytes??null;},async delete(key:string){deletes++;objects.delete(key);}};
 const request=new Request('https://synthetic.invalid/api/history/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:intent})});
 const response=await handleHistorySyncRequest(request,{db:f.db,now:()=>now,resolveHistoryRunner:async()=>authority,createPorts:async(current,claim)=>nativeHistorySyncPorts({db:f.db,bucket,authority:current,claim,now:()=>now,reader:{async read(state){return {codecVersion:1,sourceId:'source',runId:state.runId,pageId:state.phase,previousCursor:null,nextCursor:null,inventoryExhausted:true,conversations:[{id:'conversation',sourceId:'source',nativeThreadId:'native',sessionTreeId:null,parentConversationId:null,title:'Retained inventory without content',projectId:null,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:true,availability:'unavailable'}],messages:[],segments:[],attachments:[],gaps:[],objectManifest:[]};},async verify(){return {objects:[],retained:{authenticatedOwnerId:owner}};}}})});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'complete',pages:2});assert.equal(puts,2);assert.equal(deletes,0);assert.equal(objects.size,2);const ledger=f.sqlite.prepare('SELECT status,pending_token,purged_at FROM history_object_ledger WHERE user_id=?').all(owner);assert.equal(ledger.length,2);assert.ok(ledger.every(row=>row.status==='abandoned'&&row.pending_token===null&&row.purged_at===null));
 const saved=(await readHistorySyncJob(f.db,owner,intent))!;assert.equal(saved.status,'succeeded');assert.equal(saved.payload.pendingObject,null);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,2);assert.equal((await listHistoryRecords(f.db,owner,'inventory_membership')).length,1);assert.equal((await readHistoryRecord(f.db,owner,'source','source'))!.record.value.capability.unattendedRead,false);assert.equal((await readHistoryRecord(f.db,owner,'conversation','conversation'))!.record.value.availability,'unavailable');
 }finally{f.sqlite.close();}
});
