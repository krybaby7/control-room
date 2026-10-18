import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { validateDraft,saveDraft,listDrafts,deleteDraft,createDraftDebouncer,expireDrafts } from '../lib/drafts.ts';
const now='2026-10-18T00:00:00.000Z';
const draft={id:'d',entityType:'task',baseRevision:2,baseSnapshot:{title:'old'},changedFields:{title:'new'},createdAt:now,updatedAt:now,expiresAt:'2026-10-19T00:00:00.000Z'};
test('owner-scoped CAS drafts preserve newer edits and expire independently',async()=>{
 const {db,sqlite}=database();sqlite.exec('CREATE TABLE IF NOT EXISTS workspace_drafts(user_id TEXT NOT NULL,id TEXT NOT NULL,row_revision INTEGER NOT NULL,payload_json TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(user_id,id))');
 assert.equal((await saveDraft(db,'a',draft,0,now)).status,'saved');
 const results=await Promise.all([saveDraft(db,'a',{...draft,changedFields:{title:'one'}},1,now),saveDraft(db,'a',{...draft,changedFields:{title:'two'}},1,now)]);
 assert.deepEqual(results.map(result=>result.status).sort(),['conflict','saved']);
 assert.equal(await deleteDraft(db,'a','d',1),false);
 assert.equal((await listDrafts(db,'a',now))[0].draftRevision,2);
 assert.deepEqual(await listDrafts(db,'b',now),[]);
 assert.deepEqual(await listDrafts(db,'a','2026-12-20T00:00:00.000Z'),[]);
 sqlite.close();
});
test('bounded strict JSON rejects secrets, executable values and oversized Unicode',()=>{
 for(const value of [{...draft,extra:1},{...draft,changedFields:{password:'secret'}},{...draft,changedFields:{x:()=>1}},{...draft,changedFields:{x:'ع'.repeat(40000)}}])assert.throws(()=>validateDraft(value));
});
test('debounce coalesces edits and cancellation prevents scheduled writes',async()=>{
 const writes:number[]=[];const debouncer=createDraftDebouncer(async(value:number)=>{writes.push(value);},5);
 debouncer.schedule(1);debouncer.schedule(2);await new Promise(resolve=>setTimeout(resolve,15));await debouncer.settled();assert.deepEqual(writes,[2]);
 debouncer.schedule(3);debouncer.cancel();await new Promise(resolve=>setTimeout(resolve,15));assert.deepEqual(writes,[2]);
});

test('server derives retention and expired IDs require cleanup before a fresh CAS create',async()=>{
 const {db,sqlite}=database();sqlite.exec('CREATE TABLE IF NOT EXISTS workspace_drafts(user_id TEXT NOT NULL,id TEXT NOT NULL,row_revision INTEGER NOT NULL,payload_json TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(user_id,id))');
 await assert.rejects(saveDraft(db,'a',{...draft,createdAt:'2027-01-01T00:00:00.000Z'},0,now));
 const result=await saveDraft(db,'a',{...draft,updatedAt:'2030-01-01T00:00:00.000Z',expiresAt:'2030-01-02T00:00:00.000Z'},0,now);
 assert.equal(result.status,'saved');if(result.status==='saved'){assert.equal(result.draft.updatedAt,now);assert.equal(result.draft.expiresAt,'2026-11-17T00:00:00.000Z');}
 const later='2026-12-01T00:00:00.000Z';assert.equal((await saveDraft(db,'a',draft,1,later)).status,'conflict');assert.equal((await saveDraft(db,'a',draft,0,later)).status,'conflict');await expireDrafts(db,'a',later);assert.equal((await saveDraft(db,'a',draft,0,later)).status,'saved');sqlite.close();
});
