import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {contentHash} from '../lib/canonical-json.ts';
import {stageHistoryObject,finalizedHistoryObjectsGuard,MAX_HISTORY_OBJECT_BYTES,MAX_HISTORY_OWNER_OBJECT_BYTES,type HistoryObjectManifest} from '../lib/history/object-store.ts';

const scope={ownerId:'quota-synthetic-owner',sourceId:'synthetic-source',epoch:'synthetic-epoch',scopeRevision:1};
const now='2026-10-22T00:00:00.000Z';
function fixture(){
 const {db,sqlite}=database(),objects=new Map<string,Uint8Array>();let puts=0;
 const deps={db,authorize:async()=>true,now:()=>now,bucket:{async put(key:string,bytes:Uint8Array){puts++;objects.set(key,bytes.slice());},async get(key:string,maxBytes:number){const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=maxBytes);return bytes?.slice()??null;},async delete(key:string){objects.delete(key);}}};
 function seed(bytes:number,options:{owner?:string;status?:'ready'|'staging'|'abandoned';purged?:boolean}={}):HistoryObjectManifest{
  const manifest={key:`history/${crypto.randomUUID()}/${crypto.randomUUID()}`,sha256:'a'.repeat(64),bytes};
  sqlite.prepare('INSERT INTO history_object_ledger(user_id,key,source_id,epoch,scope_revision,sha256,bytes,status,pending_token,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(options.owner??scope.ownerId,manifest.key,scope.sourceId,scope.epoch,scope.scopeRevision,manifest.sha256,bytes,options.status??'ready',options.status==='staging'?crypto.randomUUID():null,now,now,options.purged?now:null);
  return manifest;
 }
 return {db,sqlite,deps,seed,puts:()=>puts};
}

test('aggregate object quota reserves bytes atomically before physical PUT and isolates owner accounting',async()=>{
 const f=fixture();try{
  assert.equal(MAX_HISTORY_OWNER_OBJECT_BYTES,256*1024*1024);
  // Retained staging and abandoned bytes remain charged until actually purged.
  for(let i=0;i<15;i++)f.seed(MAX_HISTORY_OBJECT_BYTES,{status:i%2?'staging':'abandoned'});
  f.seed(MAX_HISTORY_OBJECT_BYTES-1);
  f.seed(MAX_HISTORY_OBJECT_BYTES,{owner:'other-synthetic-owner'});
  f.seed(MAX_HISTORY_OBJECT_BYTES,{purged:true});
  const bytes=new Uint8Array([42]),input={...scope,bytes,sha256:await contentHash(bytes)};
  const results=await Promise.allSettled([stageHistoryObject(f.deps,input),stageHistoryObject(f.deps,input)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(f.puts(),1);
  assert.equal(f.sqlite.prepare('SELECT SUM(bytes) n FROM history_object_ledger WHERE user_id=? AND purged_at IS NULL').get(scope.ownerId)!.n,MAX_HISTORY_OWNER_OBJECT_BYTES);
  await assert.rejects(stageHistoryObject(f.deps,input),/capacity|authority/i);
  assert.equal(f.puts(),1);
 }finally{f.sqlite.close();}
});

test('persisted revoked-source authority rejects staging before PUT even if callback is stale',async()=>{
 const f=fixture();try{
  f.sqlite.exec('CREATE TABLE synthetic_source_authority(owner TEXT,source TEXT,epoch TEXT,scope_revision INTEGER,revoked INTEGER)');
  f.sqlite.prepare('INSERT INTO synthetic_source_authority VALUES(?,?,?,?,1)').run(scope.ownerId,scope.sourceId,scope.epoch,scope.scopeRevision);
  const guardSql={sql:'EXISTS(SELECT 1 FROM synthetic_source_authority WHERE owner=? AND source=? AND epoch=? AND scope_revision=? AND revoked=0)',params:[scope.ownerId,scope.sourceId,scope.epoch,scope.scopeRevision]};
  const bytes=new Uint8Array([7]);
  await assert.rejects(stageHistoryObject({...f.deps,guardSql},{...scope,bytes,sha256:await contentHash(bytes)}),/authority.*staging/i);
  assert.equal(f.puts(),0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_object_ledger').get()!.n,0);
 }finally{f.sqlite.close();}
});

test('manifest guard verifies 250 and 1000 objects with five bindings and rejects missing or duplicate keys',async()=>{
 const f=fixture();try{
  const manifests=Array.from({length:1000},()=>f.seed(1));
  for(const count of [250,1000]){
   const guard=finalizedHistoryObjectsGuard(scope,manifests.slice(0,count));
   assert.equal(guard.params.length,5);
   assert.ok(await f.db.prepare(`SELECT 1 valid WHERE ${guard.sql}`).bind(...guard.params).first());
  }
  f.sqlite.prepare("UPDATE history_object_ledger SET status='abandoned' WHERE user_id=? AND key=?").run(scope.ownerId,manifests[999].key);
  const guard=finalizedHistoryObjectsGuard(scope,manifests);
  assert.equal(await f.db.prepare(`SELECT 1 valid WHERE ${guard.sql}`).bind(...guard.params).first(),null);
  assert.throws(()=>finalizedHistoryObjectsGuard(scope,[manifests[0],manifests[0]]),/manifest set/i);
  assert.throws(()=>finalizedHistoryObjectsGuard(scope,[...manifests,{...manifests[0],key:`history/${crypto.randomUUID()}/${crypto.randomUUID()}`}]),/manifest set/i);
  assert.equal(f.puts(),0);
 }finally{f.sqlite.close();}
});
