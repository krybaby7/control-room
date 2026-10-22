import test from 'node:test';
import assert from 'node:assert/strict';
import {HistorySyncJobSchema,requireNativeSweepReceipt} from '../lib/history/job-store.ts';
const digest='a'.repeat(64);
test('raw JSON cannot mint a native terminal sweep receipt',async()=>{
 const expected={ownerId:'owner',intentId:'job',jobControlRevision:2,terminalControlRevision:2,jobPayloadHash:digest,progressDigest:digest,terminalPageId:'page',terminalPageDigest:digest,watermark:'1'};
 assert.equal(await requireNativeSweepReceipt(JSON.parse(JSON.stringify(expected)),expected),false);
});
test('private sweep fields are strict and old job shapes remain valid',()=>{
 const continuation={ownerId:'owner',sourceId:'source',epoch:'epoch',scopeRevision:1,generation:'generation',runId:'generation',revision:0,phase:'inventory',inventoryCursor:null,contentCursor:null,segmentCursor:null,failedItems:[],lastAttemptAt:null,lastInventorySuccessAt:null,lastContentSuccessAt:null};
 const job={version:1,controlRevision:1,sourceId:'source',epoch:'epoch',scopeRevision:1,occurrence:'occurrence',dueAt:'2026-10-22T12:00:00Z',attempt:0,retryAt:null,failure:null,lease:null,continuation,pendingObject:null};
 assert.deepEqual(HistorySyncJobSchema.parse(job),job);
 assert.equal(HistorySyncJobSchema.safeParse({...job,sweepProgress:{state:'complete'}}).success,false);
 assert.equal(HistorySyncJobSchema.safeParse({...job,sweepReceipt:{controlRevision:1,progressDigest:digest,terminalPageId:'page',terminalPageDigest:digest,watermark:'1',committedAt:job.dueAt,unexpected:true}}).success,false);
});
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId,parseHistoryRecord} from '../lib/history/record.ts';
import {enqueueHistorySync,claimHistorySync,prepareHistoryJobProgress,readNativeSweepReceipt,type HistoryRunnerAuthority} from '../lib/history/job-store.ts';
const at='2026-10-22T12:00:00.000Z';
async function fixture(){const f=database();await loadWorkspace(f.db,'owner',workspaceFixture,at);const record=parseHistoryRecord({kind:'source',id:await historyRecordId('source','source'),value:{id:'source',epoch:'epoch',scopeRevision:1,executionEpoch:0,paused:false,removedAt:null,configuration:{codecVersion:1,sourceId:'source',kind:'codex_local',epoch:'epoch',scopeRevision:1,roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'v1',normalizationVersion:'unicode-v1'},capability:{sourceId:'source',kind:'codex_local',scopeLabel:'Synthetic',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Synthetic'}}});const text=canonical(record);f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('owner',record.id,text,await contentHash(text));const authority:HistoryRunnerAuthority={ownerId:'owner',sourceId:'source',epoch:'epoch',scopeRevision:1,principalRef:'synthetic',verifiedAt:at,expiresAt:'2026-10-23T12:00:00Z',renewable:true,freshProcessReadVerified:true,renewalAndRevocationVerified:true,async guardAt(){return {sql:'1',bindings:[]};}};const id=(await enqueueHistorySync(f.db,{ownerId:'owner',sourceId:'source',kind:'history_import',dueAt:at,now:at,authority}))!,claim=(await claimHistorySync(f.db,'owner',id,{now:at,authority}))!;return {...f,authority,claim};}
test('actual SQLite progress rejects a JSON sweep token and cannot create a receipt from a cursor',async()=>{
 const f=await fixture();try{const c={...f.claim.payload.continuation,revision:1,inventoryCursor:'claimed-eof'};const changes=f.sqlite.prepare('SELECT total_changes() n').get()!.n;
 await assert.rejects(prepareHistoryJobProgress(f.db,f.claim,f.authority,at,c,null,{} as never),/Native job-bound sweep/);assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,changes);
 const prepared=(await prepareHistoryJobProgress(f.db,f.claim,f.authority,at,c,null))!;assert.ok(prepared.privateGrowth[0].bytes>0);await f.db.batch([...prepared.before,...prepared.after]);assert.equal(prepared.nextClaim.payload.sweepProgress,undefined);assert.equal(prepared.nextClaim.payload.sweepReceipt,undefined);assert.equal(await readNativeSweepReceipt(f.db,'owner',f.claim.intentId,{authority:f.authority,now:()=>at}),null);assert.equal(await readNativeSweepReceipt(f.db,'foreign',f.claim.intentId,{authority:f.authority,now:()=>at}),null);
 }finally{f.sqlite.close();}
});
import {collectionContentRunId} from '../lib/history/collection.ts';
import {encodePrivateSweepProgress,type PrivateSweepProgress} from '../lib/history/sweep-proof.ts';
test('retained terminal receipt token binds exact native DB owner, payload revision and terminal page',async()=>{
 const f=await fixture();try{
 const runId=await collectionContentRunId(f.claim.payload.continuation.generation),source=f.sqlite.prepare("SELECT id,row_revision,content_hash FROM project_history WHERE user_id='owner' AND json_extract(payload_json,'$.kind')='source'").get()!;
 const p:PrivateSweepProgress={format:'history-native-sweep/v1',binding:{ownerId:'owner',sourceId:'source',epoch:'epoch',scopeRevision:1,executionEpoch:0,generation:f.claim.payload.continuation.generation,contentRunId:runId,configurationHash:digest,sourceRow:{id:String(source.id),revision:Number(source.row_revision),hash:String(source.content_hash)},membershipRows:[],conversationIds:[],parserVersion:'v1',inventorySuccessAt:at},state:'complete',reason:null,rows:[],objects:[],segments:[],conversations:[],completedAt:at};
 const progressDigest=await contentHash(encodePrivateSweepProgress(p)),receipt={controlRevision:3,progressDigest,terminalPageId:'terminal',terminalPageDigest:digest,watermark:'1',committedAt:at},payload={...f.claim.payload,controlRevision:3,pendingObject:null,continuation:{...f.claim.payload.continuation,runId,phase:'complete',lastContentSuccessAt:at},sweepProgress:p,sweepReceipt:receipt},serialized=canonical(HistorySyncJobSchema.parse(payload));
 f.sqlite.prepare('UPDATE workspace_job_intents SET payload_json=? WHERE user_id=? AND id=?').run(serialized,'owner',f.claim.intentId);
 const logical=await contentHash(canonical(['source','epoch',1,'terminal'])),record=parseHistoryRecord({kind:'ingest_page',id:await historyRecordId('ingest_page',logical),value:{executionEpoch:0,runId,acknowledgement:{sourceId:'source',epoch:'epoch',scopeRevision:1,pageId:'terminal',pageDigest:digest,committedCursor:null,watermark:'1',committedAt:at}}}),text=canonical(record);f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('owner',record.id,text,await contentHash(text));
 const expected={ownerId:'owner',intentId:f.claim.intentId,jobControlRevision:3,terminalControlRevision:3,jobPayloadHash:await contentHash(serialized),progressDigest,terminalPageId:'terminal',terminalPageDigest:digest,watermark:'1'},token=await readNativeSweepReceipt(f.db,'owner',f.claim.intentId,{authority:f.authority,now:()=>at});assert.ok(token);assert.equal(await requireNativeSweepReceipt(token,expected),true);assert.equal(await requireNativeSweepReceipt({...token},expected),false);assert.equal(await requireNativeSweepReceipt(token,{...expected,ownerId:'foreign'}),false);
 f.sqlite.prepare('UPDATE workspace_job_intents SET payload_json=? WHERE user_id=? AND id=?').run(canonical({...payload,controlRevision:4}),'owner',f.claim.intentId);assert.equal(await requireNativeSweepReceipt(token,expected),false);
 }finally{f.sqlite.close();}
});
