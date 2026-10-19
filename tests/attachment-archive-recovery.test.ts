import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {reserveArchiveObjects} from '../lib/attachment-physical-quota.ts';
import {listArchiveStages,discardArchiveStage} from '../lib/attachment-archive-recovery.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
const now='2026-10-18T12:00:00.000Z',expires='2026-10-18T13:00:00.000Z',late='2026-10-18T14:00:00.000Z';
async function setup(){const f=database();for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);return f;}
async function stage(f:Awaited<ReturnType<typeof setup>>,owner='a',physical=false){
 const id=crypto.randomUUID(),namespace=crypto.randomUUID();const reservation=await reserveArchiveObjects(f.db,owner,{stageId:id,namespace,sourceManifestHash:'a'.repeat(64),manifestJson:'{}',createdAt:now,expiresAt:expires,targetRevision:1,records:physical?[{id:crypto.randomUUID(),bytes:3,sha256:'b'.repeat(64)}]:[]});return {id,namespace,reservation};
}
async function verified(f:Awaited<ReturnType<typeof setup>>){const archive=await stage(f);const bundle=await exportWorkspaceBundle(f.db,'a',{now:()=>now});const imported=await stageImport(f.db,'a',new TextEncoder().encode(JSON.stringify(bundle)),now);f.sqlite.prepare("UPDATE attachment_archive_stages SET status='verified',import_id=?,import_hash=? WHERE user_id='a' AND id=?").run(imported.id,imported.hash,archive.id);return {...archive,imported};}
function rows(f:Awaited<ReturnType<typeof setup>>,table:string){return f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();}
function commit(f:Awaited<ReturnType<typeof setup>>,s:Awaited<ReturnType<typeof verified>>,db=f.db){return executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'workspace.import.commit',mode:'replace',importId:s.imported.id,hash:s.imported.hash,targetRevision:1}},{db,handlers:workspaceHandlers,now:()=>now});}
test('lost-response verified stage recovers only sanitized validated metadata for its owner',async()=>{
 const f=await setup();try{const s=await verified(f);const before=rows(f,'workspaces');const page=await listArchiveStages(f.db,'a',{now});assert.equal(page.stages.length,1);assert.equal(page.nextAfter,null);assert.deepEqual(page.stages[0].recoverableStagedImport,{id:s.imported.id,hash:s.imported.hash,bytes:s.imported.bytes,diagnostics:[],expiresAt:expires});const serialized=JSON.stringify(page);assert.ok(!serialized.includes(s.namespace));assert.ok(!serialized.includes('storageKey'));assert.ok(!serialized.includes('ownerId'));assert.deepEqual(await listArchiveStages(f.db,'b',{now}),{stages:[],nextAfter:null});await assert.rejects(listArchiveStages(f.db,'',{now}));assert.deepEqual(rows(f,'workspaces'),before);
 f.sqlite.prepare("UPDATE workspace_import_chunks SET content_base64='broken' WHERE user_id='a'").run();assert.equal((await listArchiveStages(f.db,'a',{now})).stages[0].recoverableStagedImport,undefined);
 f.sqlite.prepare("UPDATE workspace_imports SET bytes='corrupt-byte-metadata' WHERE user_id='a'").run();assert.equal((await listArchiveStages(f.db,'a',{now})).stages[0].recoverableStagedImport,undefined);
 }finally{f.sqlite.close();}
});
test('expired/failed stages retain physical charges and pending attempts without recoverable import claims',async()=>{
 const f=await setup();try{const s=await stage(f,'a',true);const key=s.reservation.records[0].storageKey;f.sqlite.prepare("INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at) VALUES('a',?,?,?,?)").run(crypto.randomUUID(),s.reservation.records[0].id,key,now);const physical=rows(f,'attachment_blob_objects'),pending=rows(f,'attachment_upload_attempts');
 assert.equal(await discardArchiveStage(f.db,'a',s.id,now),true);const summary=(await listArchiveStages(f.db,'a',{now:late})).stages[0];assert.equal(summary.status,'failed');assert.deepEqual(summary.physicalCharged,{files:1,bytes:3});assert.equal(summary.pendingUploadCount,1);assert.equal(summary.recoverableStagedImport,undefined);assert.deepEqual(rows(f,'attachment_blob_objects'),physical);assert.deepEqual(rows(f,'attachment_upload_attempts'),pending);assert.equal(await discardArchiveStage(f.db,'a',s.id,late),false);
 const expired=await verified(f);assert.equal((await listArchiveStages(f.db,'a',{now:late})).stages.find(row=>row.id===expired.id)!.recoverableStagedImport,undefined);
 }finally{f.sqlite.close();}
});
test('UUID keyset pages reach every owner stage exactly once with strict bounded options',async()=>{
 const f=await setup();try{for(let index=0;index<57;index++){const id=crypto.randomUUID();f.sqlite.prepare("INSERT INTO attachment_archive_stages(user_id,id,namespace,source_manifest_hash,manifest_json,created_at,expires_at,target_revision,status) VALUES('a',?,?,?,'{}',?,?,1,'failed')").run(id,crypto.randomUUID(),'a'.repeat(64),now,expires);}await stage(f,'b');let after:string|undefined;const ids:string[]=[];do{const page=await listArchiveStages(f.db,'a',{now,limit:13,...(after?{after}:{})});assert.ok(page.stages.length<=13);ids.push(...page.stages.map(row=>row.id));after=page.nextAfter??undefined;}while(after);assert.equal(ids.length,57);assert.equal(new Set(ids).size,57);assert.deepEqual(ids,[...ids].sort());await assert.rejects(listArchiveStages(f.db,'a',{now,limit:51}));await assert.rejects(listArchiveStages(f.db,'a',{now,after:'foreign'}));
 }finally{f.sqlite.close();}
});
test('discard deletes only matching metadata quarantine and never touches committed or foreign stages',async()=>{
 const f=await setup();try{const s=await verified(f),other=await stageImport(f.db,'a',new TextEncoder().encode('{}'),now);const active=rows(f,'workspaces');assert.equal(await discardArchiveStage(f.db,'b',s.id,now),false);assert.equal(await discardArchiveStage(f.db,'a',s.id,now),true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_imports WHERE id=?').get(s.imported.id)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_import_chunks WHERE import_id=?').get(s.imported.id)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_imports WHERE id=?').get(other.id)!.n,1);assert.deepEqual(rows(f,'workspaces'),active);
 const committed=await verified(f);await commit(f,committed);const prior=rows(f,'workspace_imports');assert.equal(await discardArchiveStage(f.db,'a',committed.id,now),false);assert.deepEqual(rows(f,'workspace_imports'),prior);assert.equal((await listArchiveStages(f.db,'a',{now})).stages.find(row=>row.id===committed.id)!.status,'committed');
 }finally{f.sqlite.close();}
});
test('actual import/discard batch ordering serializes authority in both race directions',async()=>{
 for(const first of ['discard','commit'] as const){const f=await setup();try{const s=await verified(f);if(first==='discard'){
  let raced=false;const db:SqlDatabase={...f.db,async batch(statements){if(!raced){raced=true;await discardArchiveStage(f.db,'a',s.id,now);}return f.db.batch(statements);}};
  await assert.rejects(commit(f,s,db));assert.equal((await readCurrent(f.db,'a')).revision,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workspace_mutations WHERE user_id='a'").get()!.n,0);
 }else{let raced=false;const db:SqlDatabase={...f.db,async batch(statements){if(!raced){raced=true;await commit(f,s);}return f.db.batch(statements);}};assert.equal(await discardArchiveStage(db,'a',s.id,now),false);assert.equal((await readCurrent(f.db,'a')).revision,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_imports WHERE id=?').get(s.imported.id)!.n,1);}
 }finally{f.sqlite.close();}}
});
