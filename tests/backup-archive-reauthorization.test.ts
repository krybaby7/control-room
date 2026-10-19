import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {createR2BlobStore,type AttachmentBucket} from '../lib/attachments.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import type {RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
import {runScheduledBackup} from '../lib/automations/backup-store.ts';
import {readReadyFileBackup,type FileBackupServices} from '../lib/automations/backup-archive-store.ts';
import {prepareFileBackupRemoval,fileBackupRemovalStatements} from '../lib/automations/backup-archive-removal.ts';
import {cleanupRetiredFileBackup,reauthorizeRetiredFileBackup,type BackupArchiveCleanupBucket} from '../lib/automations/backup-archive-cleanup.ts';
import {readBackupQuotaUsage} from '../lib/backup-archive-quota.ts';
import {type BackupArchiveBucket} from '../lib/backup-archive-storage.ts';
const now='2026-10-18T12:00:00.000Z',principal={ownerId:'synthetic-backup-owner',principalId:'synthetic-backup-principal'};
/** REAL isolated local D1/R2 emulator; private registration below is synthetic fixture authority only. */
async function fixture(options:{fileBytes?:number;fileMode?:boolean}={}){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated backup fixture")}}',compatibilityDate:'2026-05-22',d1Databases:['DB'],r2Buckets:['BUCKET']});
 try{
  const native=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
  for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()){
   for(const sql of readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8').split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean))await native.prepare(sql).run();
  }
  const statements=new WeakMap<SqlStatement,ReturnType<typeof native.prepare>>(),texts=new WeakMap<SqlStatement,string>();
  const hooks:{beforeBatch?:(sqls:string[])=>Promise<void>;afterBatch?:(sqls:string[])=>Promise<void>}={};
  const db:SqlDatabase={prepare(sql){let prepared=native.prepare(sql);const statement:SqlStatement={bind(...values){prepared=prepared.bind(...values);statements.set(statement,prepared);return this;},first<T>(){return prepared.first<T>();},all<T>(){return prepared.all<T>();},async run(){const result=await prepared.run();return {meta:{changes:result.meta.changes}};}};statements.set(statement,prepared);texts.set(statement,sql);return statement;},async batch(items){const sqls=items.map(item=>texts.get(item)!);await hooks.beforeBatch?.(sqls);const result=await native.batch(items.map(item=>statements.get(item)!));await hooks.afterBatch?.(sqls);return result.map(item=>({results:item.results,meta:{changes:item.meta.changes}}));}};
  const run=async(sql:string,...values:(string|number|null)[])=>db.prepare(sql).bind(...values).run();
  for(const owner of [principal.ownerId,'synthetic-other-owner'])await loadWorkspace(db,owner,()=>workspaceFixture(),now);
  const namespace=(await getWorkspaceNamespaces(db,principal.ownerId))!.blobNamespace,attachmentId=crypto.randomUUID(),bytes=new Uint8Array(options.fileBytes??9*1024*1024).fill(65),sha256=await contentHash(bytes),key='attachments/'+namespace+'/'+attachmentId;
  const record={id:attachmentId,status:'ready',filename:'synthetic-backup-source.txt',mimeType:'text/plain',expectedBytes:bytes.length,actualBytes:bytes.length,sha256,storageKey:key,createdAt:now,expiresAt:'2026-10-18T13:00:00.000Z',readyAt:now,uploadMutationId:'synthetic-source-upload',quarantineReason:null};
  async function put(table:RegisteredOwnerTable,id:string,value:unknown){const columns=moduleColumnNames(table),projection=await moduleProjection(table,id,value as JsonValue),payload=canonical(value);await run('INSERT INTO '+table+'(user_id,id,row_revision,payload_json,content_hash'+columns.map(column=>','+column).join('')+') VALUES(?,?,1,?,?'+columns.map(()=>',?').join('')+')',principal.ownerId,id,payload,await contentHash(payload),...columns.map(column=>projection[column]));}
  await put('attachments',attachmentId,record);await put('attachment_usage','quota',{bytes:bytes.length,files:1});
  await run('INSERT INTO attachment_blob_objects(user_id,storage_key,namespace,attachment_id,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,NULL)',principal.ownerId,key,namespace,attachmentId,bytes.length,sha256,now,now);
  await createR2BlobStore(bucket as AttachmentBucket).put(key,bytes,{bytes:bytes.length,sha256,mimeType:'text/plain'});
  const schedule={id:'synthetic-file-backup-schedule',kind:'backup',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'09:00'},sourceId:null,projectIds:[],catchUp:'latest_only',...(options.fileMode===false?{}:{backupMode:'files',fileBackupConsent:true}),createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',archivedAt:null},hash=await contentHash(canonical(schedule));
  await run('INSERT INTO automation_schedules(user_id,id,row_revision,payload_json,content_hash,kind,enabled,configuration_version) VALUES(?,?,1,?,?,?,1,1)',principal.ownerId,schedule.id,canonical(schedule),hash,'backup');
  await run('INSERT INTO automation_runtime(user_id,schedule_id,configuration_hash,operational_revision,execution_epoch,paused,next_due_at,principal_ref) VALUES(?,?,?,1,0,0,?,?)',principal.ownerId,schedule.id,hash,'2026-10-19T06:00:00.000Z',principal.principalId);
  await run('INSERT INTO integration_service_principals(user_id,id,token_hash,scope_json,expires_at,renewable_verified_at) VALUES(?,?,?,?,?,?)',principal.ownerId,principal.principalId,'a'.repeat(64),'["automation:run"]','2027-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  await run("INSERT INTO automation_capabilities(user_id,kind,resource_id,principal_ref,verified_at,expires_at,proof_kind) VALUES(?,'backup',?,?,?,?,'live-unattended')",principal.ownerId,schedule.id,principal.principalId,'2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z');
  let serial=0;async function admit(){const intentId='synthetic-backup-intent-'+(++serial),backupId=crypto.randomUUID(),dueAt='2026-10-18T06:'+String(serial).padStart(2,'0')+':00.000Z',payload={backupId};
   await run("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'workspace_backup',?,?,?,'pending',0,0)",principal.ownerId,intentId,intentId,canonical(payload),now);
   await run("INSERT INTO integration_jobs(user_id,intent_id,source_id,job_subject_kind,subject_id,schedule_id,schedule_configuration_hash,occurrence_due_at,configuration_hash,operational_revision) VALUES(?,?,NULL,'backup',?,?,?,?,?,1)",principal.ownerId,intentId,backupId,schedule.id,hash,dueAt,await contentHash(canonical(payload)));
   await run('INSERT INTO automation_occurrence_claims(user_id,schedule_id,due_at,intent_id,configuration_hash,execution_epoch,admitted_at,missed_periods,principal_ref) VALUES(?,?,?,?,?,0,?,0,?)',principal.ownerId,schedule.id,dueAt,intentId,hash,now,principal.principalId);return {intentId,backupId};}
  const services:FileBackupServices={bucket:bucket as BackupArchiveBucket,attachmentBucket:bucket as AttachmentBucket};
  const count=async(table:string)=>Number((await db.prepare('SELECT COUNT(*) n FROM '+table).first<{n:number}>())!.n);
  return {mf,db,bucket,services,hooks,run,admit,count,bytes,record,schedule};
 }catch(error){await mf.dispose();throw error;}
}

// Presence checks must settle native R2 bodies before disposing the isolated worker.
async function assertStoredObject(f:Awaited<ReturnType<typeof fixture>>,key:string){const object=await f.bucket.get(key);assert.ok(object);await object.arrayBuffer();}
const later='2026-10-18T12:01:00.000Z',retiredAt='2026-10-18T12:02:00.000Z',authorizedAt='2026-10-18T12:03:00.000Z';
async function retiredFixture(){
 const f=await fixture({fileBytes:1024});try{
  const first=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,first.intentId,{now:()=>now,files:f.services})).status,'completed');
  const newer=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,newer.intentId,{now:()=>later,files:f.services})).status,'completed');
  const logical=(await f.db.prepare('SELECT sha256 FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,first.backupId).first<{sha256:string}>())!;
  const newerLogical=(await f.db.prepare('SELECT sha256 FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,newer.backupId).first<{sha256:string}>())!;
  const control=await prepareFileBackupRemoval(f.db,principal.ownerId,{id:first.backupId,sha256:logical.sha256,newerId:newer.backupId,newerSha256:newerLogical.sha256},f.services,retiredAt);
  await f.db.batch([...fileBackupRemovalStatements(f.db,principal.ownerId,control,retiredAt,'1',[],'synthetic-reauthorization-retire'),f.db.prepare('DELETE FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,first.backupId)]);
  await f.run('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET epoch=excluded.epoch,restored_at=excluded.restored_at',principal.ownerId,authorizedAt);
  const input={id:first.backupId,indexHash:control.selected.archive.index_sha256,newerId:newer.backupId,newerSha256:newerLogical.sha256};
  const bucket:BackupArchiveCleanupBucket={get:key=>f.services.bucket.get(key),put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),delete:key=>f.bucket.delete(key)};
  return {...f,first,newer,control,input,cleanupBucket:bucket};
 }catch(error){await f.mf.dispose();throw error;}
}
test('fresh explicit owner proof reauthorizes an old-epoch retired archive without DELETE then separate cleanup releases confirmed charge',async()=>{
 const f=await retiredFixture();try{
  const before=await readCurrent(f.db,principal.ownerId,authorizedAt),quota=await readBackupQuotaUsage(f.db,principal.ownerId),oldKey=f.control.selected.objects[0].storage_key;
  assert.equal((await cleanupRetiredFileBackup(f.db,principal.ownerId,{id:f.input.id,indexHash:f.input.indexHash},{now:()=>authorizedAt,bucket:f.cleanupBucket})).reason,'authorization_stale');
  let deletes=0;const services={...f.services,bucket:{...f.cleanupBucket,async delete(key:string){deletes++;await f.bucket.delete(key);}}};
  assert.deepEqual(await reauthorizeRetiredFileBackup(f.db,principal.ownerId,f.input,{now:()=>authorizedAt,services}),{status:'authorized',id:f.input.id,indexHash:f.input.indexHash,executionEpoch:1});
  assert.equal(deletes,0);assert.equal(await f.count('backup_archive_cleanup_claims'),0);await assertStoredObject(f,oldKey);assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),quota);
  assert.equal((await f.db.prepare('SELECT execution_epoch FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,f.input.id).first<{execution_epoch:number}>())!.execution_epoch,1);
  const cleaned=await cleanupRetiredFileBackup(f.db,principal.ownerId,{id:f.input.id,indexHash:f.input.indexHash},{now:()=>authorizedAt,bucket:services.bucket});
  assert.equal(cleaned.status,'completed');assert.equal(deletes,1);assert.equal(await f.bucket.get(oldKey),null);
  assert.equal((await readBackupQuotaUsage(f.db,principal.ownerId)).bytes,quota.bytes-f.control.selected.archive.zip_bytes);
  const newer=await readReadyFileBackup(f.db,principal.ownerId,f.newer.backupId,f.services);assert.ok(newer);await new Response(newer.stream).arrayBuffer();
  assert.deepEqual(await readCurrent(f.db,principal.ownerId,authorizedAt),before);
 }finally{await f.mf.dispose();}
});
test('foreign owner, forged/newer SHA, same point and missing actual newer bytes cannot revive old cleanup authority',async()=>{
 const f=await retiredFixture();try{
  await assert.rejects(reauthorizeRetiredFileBackup(f.db,'synthetic-other-owner',f.input,{now:()=>authorizedAt,services:f.services}));
  await assert.rejects(reauthorizeRetiredFileBackup(f.db,principal.ownerId,{...f.input,newerSha256:'e'.repeat(64)},{now:()=>authorizedAt,services:f.services}));
  await assert.rejects(reauthorizeRetiredFileBackup(f.db,principal.ownerId,{...f.input,newerId:f.input.id},{now:()=>authorizedAt,services:f.services}),/different strictly newer/);
  await f.bucket.delete(f.control.newer.objects[0].storage_key);
  await assert.rejects(reauthorizeRetiredFileBackup(f.db,principal.ownerId,f.input,{now:()=>authorizedAt,services:f.services}));
  assert.equal((await f.db.prepare('SELECT execution_epoch FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,f.input.id).first<{execution_epoch:number}>())!.execution_epoch,0);
  assert.equal(await f.count('backup_archive_cleanup_claims'),0);await assertStoredObject(f,f.control.selected.objects[0].storage_key);
 }finally{await f.mf.dispose();}
});
test('current epoch, old/new ledger and permanent-claim races abort reauthorization without partial epoch stamp',async()=>{
 for(const race of ['epoch','old','newer','claim'] as const){
  const f=await retiredFixture();try{
   let changed=false;
   const services={...f.services,bucket:{...f.cleanupBucket,async get(key:string){
    if(!changed&&key===f.control.newer.objects[0].storage_key){changed=true;
     if(race==='epoch')await f.run('UPDATE workspace_execution_state SET epoch=2 WHERE user_id=?',principal.ownerId);
     else if(race==='claim')await f.run('INSERT INTO backup_archive_cleanup_claims(user_id,storage_key,archive_id,part_number,token,claimed_at,purged_at) VALUES(?,?,?,0,?,?,NULL)',principal.ownerId,f.control.selected.objects[0].storage_key,f.input.id,crypto.randomUUID(),authorizedAt);
     else await f.run('UPDATE backup_archive_objects SET verified_at=? WHERE user_id=? AND archive_id=?','2026-10-18T12:00:30.000Z',principal.ownerId,race==='old'?f.input.id:f.input.newerId);
    }return f.services.bucket.get(key);
   }}};
   await assert.rejects(reauthorizeRetiredFileBackup(f.db,principal.ownerId,f.input,{now:()=>authorizedAt,services}));
   assert.equal((await f.db.prepare('SELECT execution_epoch FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,f.input.id).first<{execution_epoch:number}>())!.execution_epoch,0);
   await assertStoredObject(f,f.control.selected.objects[0].storage_key);await assertStoredObject(f,f.control.newer.objects[0].storage_key);
  }finally{await f.mf.dispose();}
 }
});
test('fresh reauthorization preserves unknown DELETE fences: present old bytes never get a second DELETE; absence can reconcile',async()=>{
 const f=await retiredFixture();try{
  const object=f.control.selected.objects[0],token=crypto.randomUUID(),quota=await readBackupQuotaUsage(f.db,principal.ownerId);
  await f.run('INSERT INTO backup_archive_cleanup_claims(user_id,storage_key,archive_id,part_number,token,claimed_at,purged_at) VALUES(?,?,?,?,?,?,NULL)',principal.ownerId,object.storage_key,f.input.id,object.part_number,token,now);
  assert.equal((await reauthorizeRetiredFileBackup(f.db,principal.ownerId,f.input,{now:()=>authorizedAt,services:f.services})).status,'authorized');
  let deletes=0;const bucket={...f.cleanupBucket,async delete(){deletes++;}};
  const input={id:f.input.id,indexHash:f.input.indexHash};
  assert.equal((await cleanupRetiredFileBackup(f.db,principal.ownerId,input,{now:()=>authorizedAt,bucket})).status,'uncertain');assert.equal(deletes,0);
  assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),quota);
  await f.bucket.delete(object.storage_key); // synthetic delayed first DELETE finally settles
  assert.equal((await cleanupRetiredFileBackup(f.db,principal.ownerId,input,{now:()=>authorizedAt,bucket})).status,'completed');assert.equal(deletes,0);
  assert.equal((await readBackupQuotaUsage(f.db,principal.ownerId)).bytes,quota.bytes-f.control.selected.archive.zip_bytes);
  assert.equal((await f.db.prepare('SELECT token FROM backup_archive_cleanup_claims WHERE user_id=? AND storage_key=?').bind(principal.ownerId,object.storage_key).first<{token:string}>())!.token,token);
 }finally{await f.mf.dispose();}
});
test('unsettled old PUT remains charged and cannot be reauthorized by historical metadata',async()=>{
 const f=await retiredFixture();try{
  const quota=await readBackupQuotaUsage(f.db,principal.ownerId);
  await f.run('UPDATE backup_archive_objects SET pending_token=?,settled_at=NULL WHERE user_id=? AND archive_id=?',crypto.randomUUID(),principal.ownerId,f.input.id);
  await assert.rejects(reauthorizeRetiredFileBackup(f.db,principal.ownerId,f.input,{now:()=>authorizedAt,services:f.services}),/unsettled/);
  assert.equal((await f.db.prepare('SELECT execution_epoch FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,f.input.id).first<{execution_epoch:number}>())!.execution_epoch,0);
  assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),quota);assert.equal(await f.count('backup_archive_cleanup_claims'),0);
 }finally{await f.mf.dispose();}
});
