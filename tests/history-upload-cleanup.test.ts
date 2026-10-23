import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readHistoryRecord} from '../lib/history/store.ts';
import {enrollHistoryIngestCredential} from '../lib/history/auth.ts';
import {handleHistoryTransport} from '../lib/history/http.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {MAX_HISTORY_OBJECT_BYTES,MAX_HISTORY_OWNER_OBJECT_BYTES} from '../lib/history/object-store.ts';
const owner='synthetic-cleanup-owner',sourceId='synthetic-source',now='2026-10-22T12:00:00.000Z',old='2026-10-22T11:50:00.000Z';
// Actual HTTP/auth/SQLite quota and cleanup, with synthetic private ingress and
// memory bucket. Ledger capacity fixtures allocate no actual 256 MiB payload.
async function fixture(){
 const f=database();await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
 const configured=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'history.source.configure',sourceId,expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic',roots:['synthetic-root'],accountId:null,deviceId:null,includeArchived:true,exclusions:[]}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.equal(configured.status,'committed');
 const source=(await readHistoryRecord(f.db,owner,'source',sourceId))!.record.value;
 const enrollment=await enrollHistoryIngestCredential(f.db,{authenticatedOwnerId:owner,authorizeOwner:async()=>true},{sourceId,expiresAt:'2026-10-22T13:00:00.000Z'},now);
 const deleted:string[]=[],objects=new Map<string,Uint8Array>();let puts=0;
 const services={db:f.db,now:()=>now,privateIngress:{async verify(){return {serviceIdentity:'synthetic-private-ingress'};}},bucket:{async put(key:string,bytes:Uint8Array){puts++;objects.set(key,bytes.slice());},async get(key:string,maxBytes:number){const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=maxBytes);return bytes??null;},async delete(key:string){deleted.push(key);objects.delete(key);}}};
 function seed(options:{owner?:string;source?:string;pending?:boolean;recent?:boolean;ready?:boolean}={}){const key=`history/${crypto.randomUUID()}/${crypto.randomUUID()}`;f.sqlite.prepare('INSERT INTO history_object_ledger(user_id,key,source_id,epoch,scope_revision,sha256,bytes,status,pending_token,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(options.owner??owner,key,options.source??sourceId,source.epoch,source.scopeRevision,'a'.repeat(64),MAX_HISTORY_OBJECT_BYTES,options.pending?'staging':options.ready?'ready':'abandoned',options.pending?'pending-'+crypto.randomUUID():null,options.recent?now:old,null);return key;}
 async function upload(){const bytes=new Uint8Array([42]);return handleHistoryTransport('objects',new Request('https://synthetic.invalid/api/history/objects',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Control-Room-History':enrollment.token,'X-History-Source':sourceId,'X-History-Epoch':source.epoch,'X-History-Scope-Revision':String(source.scopeRevision),'X-History-SHA256':await contentHash(bytes),'X-History-Upload-Id':'upload_'+'b'.repeat(64)},body:bytes}),services);}
 const retained=()=>Number(f.sqlite.prepare('SELECT SUM(bytes) n FROM history_object_ledger WHERE user_id=? AND purged_at IS NULL').get(owner)!.n);
 return {...f,seed,upload,deleted,retained,puts:()=>puts};
}
test('preupload grace cleanup unwedges full owner quota and preserves pending, referenced and foreign objects',async()=>{const f=await fixture();try{
 const eligible=Array.from({length:10},()=>f.seed()),pending=f.seed({pending:true}),recent=f.seed({recent:true}),ready=f.seed({ready:true}),otherSource=f.seed({source:'synthetic-other-source'}),referenced=f.seed(),jobReferenced=f.seed(),foreign=f.seed({owner:'synthetic-other-owner'});
 const payload=canonical({id:'synthetic-reference',kind:'segment',value:{objectKey:referenced}});
 f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(owner,'synthetic-reference',payload,await contentHash(payload));
 f.sqlite.prepare('INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status) VALUES(?,?,?,?,?,?,?)').run(owner,'synthetic-job','area_analysis','synthetic-job',canonical({pendingObject:{key:jobReferenced}}),now,'pending');
 assert.equal(f.retained(),MAX_HISTORY_OWNER_OBJECT_BYTES);const response=await f.upload();assert.equal(response.status,201,await response.text());assert.equal(f.puts(),1);
 assert.deepEqual(new Set(f.deleted),new Set(eligible));assert.equal(f.retained(),6*MAX_HISTORY_OBJECT_BYTES+1);
 for(const key of eligible)assert.equal(f.sqlite.prepare('SELECT purged_at FROM history_object_ledger WHERE user_id=? AND key=?').get(owner,key)!.purged_at,now);
 for(const key of [pending,recent,ready,otherSource,referenced,jobReferenced,foreign])assert.equal(f.sqlite.prepare('SELECT purged_at FROM history_object_ledger WHERE key=?').get(key)!.purged_at,null);
 assert.ok(f.sqlite.prepare('SELECT pending_token FROM history_object_ledger WHERE key=?').get(pending)!.pending_token);
 }finally{f.sqlite.close();}});
test('full noneligible quota returns 429 without PUT, deletion or ledger changes',async()=>{const f=await fixture();try{
 for(let i=0;i<16;i++)f.seed({pending:true});const before=f.sqlite.prepare('SELECT * FROM history_object_ledger ORDER BY key').all();const response=await f.upload();assert.equal(response.status,429);assert.equal((await response.json() as {diagnostic:string}).diagnostic,'history_capacity');assert.equal(f.retained(),MAX_HISTORY_OWNER_OBJECT_BYTES);assert.equal(f.puts(),0);assert.deepEqual(f.deleted,[]);assert.deepEqual(f.sqlite.prepare('SELECT * FROM history_object_ledger ORDER BY key').all(),before);
 }finally{f.sqlite.close();}});
test('revoked upload authorization performs zero orphan deletions',async()=>{const f=await fixture();try{
 const key=f.seed();f.sqlite.prepare('UPDATE history_ingest_credentials SET revoked_at=? WHERE user_id=?').run(now,owner);const response=await f.upload();assert.equal(response.status,401);assert.deepEqual(f.deleted,[]);assert.equal(f.puts(),0);assert.equal(f.sqlite.prepare('SELECT purged_at FROM history_object_ledger WHERE key=?').get(key)!.purged_at,null);
 }finally{f.sqlite.close();}});
