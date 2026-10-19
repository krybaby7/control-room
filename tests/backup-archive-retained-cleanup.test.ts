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
import {readBackupQuotaUsage,backupQuotaGuard} from '../lib/backup-archive-quota.ts';
import {backupArchiveKey,createBackupArchiveStorage,type BackupArchiveBucket} from '../lib/backup-archive-storage.ts';
import type {BackupArchiveCleanupBucket} from '../lib/automations/backup-archive-cleanup.ts';
import {prepareFileBackupRemoval,fileBackupRemovalStatements} from '../lib/automations/backup-archive-removal.ts';
import {cleanupRetainedFileBackup,listRetainedFileBackupGenerations} from '../lib/automations/backup-archive-retained-cleanup.ts';
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

async function prepared(fileBytes=1024){
 const f=await fixture({fileBytes});try{
 const job=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services})).status,'completed');
 const ready=await readReadyFileBackup(f.db,principal.ownerId,job.backupId,f.services);assert.ok(ready);await ready.stream.cancel();
 const current=(await f.db.prepare('SELECT namespace FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,job.backupId).first<{namespace:string}>())!.namespace;
 const old=crypto.randomUUID(),storage=createBackupArchiveStorage(f.services.bucket);
 for(const chunk of ready.index.chunks){
  const body=await storage.get(current,chunk);assert.ok(body);await storage.put(old,chunk,body);
  await f.run('INSERT INTO backup_archive_retained_objects(user_id,storage_key,source_archive_id,part_number,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)',principal.ownerId,backupArchiveKey(old,chunk.part),job.backupId,chunk.part,old,chunk.bytes,chunk.sha256,now,now);
 }
 const listing=await listRetainedFileBackupGenerations(f.db,principal.ownerId);assert.equal(listing.items.length,1);
 const item=listing.items[0],input={id:item.id,indexHash:item.indexHash,generationHash:item.generationHash};
 const bucket:BackupArchiveCleanupBucket={get:key=>f.services.bucket.get(key),put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),delete:key=>f.bucket.delete(key)};
 const services:FileBackupServices&{bucket:BackupArchiveCleanupBucket}={...f.services,bucket};
 return {...f,job,ready,current,old,item,input,cleanupServices:services};
 }catch(error){await f.mf.dispose();throw error;}
}
test('actual D1/R2 verified identical current archive permits explicit old-generation cleanup and removes the 18MB capacity deadlock',async()=>{
 const f=await prepared(9*1024*1024);try{
  const before=await readCurrent(f.db,principal.ownerId,now),quota=await readBackupQuotaUsage(f.db,principal.ownerId);
  const extra=f.ready.index.zipBytes+100000,guard=backupQuotaGuard(principal.ownerId,extra,1);
  assert.equal((await f.db.prepare('SELECT CASE WHEN '+guard.sql+' THEN 1 ELSE 0 END ok').bind(...guard.bindings).first<{ok:number}>())!.ok,0);
  const deleted:string[]=[];const services={...f.cleanupServices,bucket:{...f.cleanupServices.bucket,async delete(key:string){deleted.push(key);await f.bucket.delete(key);}}};
  const result=await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services});
  assert.equal(result.status,'completed');assert.equal(result.retainedBytes,0);assert.equal(result.purgedParts,3);assert.equal(result.physicalDeletion,true);
  assert.deepEqual(deleted,f.ready.index.chunks.map(chunk=>backupArchiveKey(f.old,chunk.part)));
  assert.equal((await readBackupQuotaUsage(f.db,principal.ownerId)).bytes,quota.bytes-f.ready.index.zipBytes);
  assert.equal(await f.count('backup_archive_retained_objects'),3,'permanent old identities are never removed');
  assert.equal(await f.count('backup_archive_cleanup_claims'),3);assert.equal(await f.count('workspace_backups'),1);
  const current=await readReadyFileBackup(f.db,principal.ownerId,f.job.backupId,f.services);assert.ok(current);assert.equal(current.indexHash,f.input.indexHash);await current.stream.cancel();
  assert.deepEqual(await readCurrent(f.db,principal.ownerId,now),before);
  assert.equal((await listRetainedFileBackupGenerations(f.db,principal.ownerId)).items.length,0);
  const next=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,next.intentId,{now:()=>now,files:f.services})).status,'completed','new full backup now fits without deleting the current recovery point');
 }finally{await f.mf.dispose();}
});
test('foreign owner, forged generation and corrupted retained descriptor cannot claim or delete a key',async()=>{
 const f=await prepared();try{
  assert.deepEqual(await listRetainedFileBackupGenerations(f.db,'synthetic-other-owner'),{items:[],nextAfter:null});
  await assert.rejects(cleanupRetainedFileBackup(f.db,'synthetic-other-owner',f.input,{now:()=>now,services:f.cleanupServices}));
  await assert.rejects(cleanupRetainedFileBackup(f.db,principal.ownerId,{...f.input,generationHash:'f'.repeat(64)},{now:()=>now,services:f.cleanupServices}));
  await f.run('UPDATE backup_archive_retained_objects SET sha256=? WHERE user_id=?','b'.repeat(64),principal.ownerId);
  await assert.rejects(cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services:f.cleanupServices}));
  assert.equal(await f.count('backup_archive_cleanup_claims'),0);assert.ok(await f.bucket.get(backupArchiveKey(f.old,0)));assert.ok(await f.bucket.get(backupArchiveKey(f.current,0)));
 }finally{await f.mf.dispose();}
});
test('metadata alone and missing/corrupt current R2 bytes never authorize retained cleanup',async()=>{
 for(const corrupt of [false,true]){
  const f=await prepared();try{
   const quota=await readBackupQuotaUsage(f.db,principal.ownerId),currentKey=backupArchiveKey(f.current,0);
   assert.equal((await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now})).reason,'storage_unavailable');
   if(corrupt)await f.bucket.put(currentKey,new Uint8Array([1,2,3]));else await f.bucket.delete(currentKey);
   let deletes=0;const services={...f.cleanupServices,bucket:{...f.cleanupServices.bucket,async delete(){deletes++;}}};
   const result=await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services});
   assert.notEqual(result.status,'completed');assert.equal(deletes,0);assert.equal(await f.count('backup_archive_cleanup_claims'),0);
   assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),quota);assert.ok(await f.bucket.get(backupArchiveKey(f.old,0)));
  }finally{await f.mf.dispose();}
 }
});
test('lost DELETE response remains charged then reconciles actual absence without another DELETE',async()=>{
 const f=await prepared();try{
  const quota=await readBackupQuotaUsage(f.db,principal.ownerId);let deletes=0;
  const services={...f.cleanupServices,bucket:{...f.cleanupServices.bucket,async delete(key:string){deletes++;await f.bucket.delete(key);throw new Error('synthetic response lost');}}};
  const first=await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services});assert.equal(first.status,'uncertain');assert.equal(first.physicalDeletion,false);
  assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),quota);assert.equal(await f.count('backup_archive_cleanup_claims'),1);
  const replay=await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services});assert.equal(replay.status,'completed');assert.equal(deletes,1);
  assert.equal((await readBackupQuotaUsage(f.db,principal.ownerId)).bytes,quota.bytes-f.ready.index.zipBytes);assert.ok(await f.bucket.get(backupArchiveKey(f.current,0)));
 }finally{await f.mf.dispose();}
});
test('hanging DELETE is bounded; a retained present key with a permanent claim is never deleted twice',async()=>{
 const f=await prepared();try{
  let deletes=0,finish:(()=>void)|undefined;
  const services={...f.cleanupServices,bucket:{...f.cleanupServices.bucket,async delete(key:string){deletes++;await new Promise<void>(resolve=>{finish=resolve;});await f.bucket.delete(key);}}};
  assert.equal((await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services,deleteDeadlineMs:5})).status,'uncertain');
  assert.equal((await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services,deleteDeadlineMs:5})).status,'uncertain');assert.equal(deletes,1);
  finish!();for(let tries=0;tries<50&&await f.bucket.get(backupArchiveKey(f.old,0));tries++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal((await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services})).status,'completed');assert.equal(deletes,1);assert.ok(await f.bucket.get(backupArchiveKey(f.current,0)));
 }finally{await f.mf.dispose();}
});
test('epoch or exact current ledger change between physical proof and claim blocks every old DELETE',async()=>{
 for(const change of ['epoch','ledger'] as const){
  const f=await prepared();try{
   let changed=false,deletes=0;const services={...f.cleanupServices,bucket:{...f.cleanupServices.bucket,async get(key:string){if(!changed&&key===backupArchiveKey(f.old,0)){changed=true;if(change==='epoch')await f.run('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET epoch=excluded.epoch,restored_at=excluded.restored_at',principal.ownerId,now);else await f.run('UPDATE backup_archive_objects SET verified_at=? WHERE user_id=? AND archive_id=?','2026-10-18T12:00:01.000Z',principal.ownerId,f.job.backupId);}return f.services.bucket.get(key);},async delete(){deletes++;}}};
   const result=await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>now,services});assert.equal(result.status,'blocked');assert.equal(result.reason,'authorization_stale');assert.equal(deletes,0);assert.equal(await f.count('backup_archive_cleanup_claims'),0);
   assert.ok(await f.bucket.get(backupArchiveKey(f.old,0)));
  }finally{await f.mf.dispose();}
 }
});
test('sanitized retained-generation listing exposes no owner/key/namespace and paginates archive IDs',async()=>{
 const f=await prepared();try{
  const page=await listRetainedFileBackupGenerations(f.db,principal.ownerId,{limit:1});assert.equal(page.items.length,1);assert.equal(page.nextAfter,null);
  const text=JSON.stringify(page);assert.equal(text.includes(principal.ownerId),false);assert.equal(text.includes(f.old),false);assert.equal(text.includes(f.current),false);assert.equal(text.includes('backups/'),false);
  const next=await listRetainedFileBackupGenerations(f.db,principal.ownerId,{after:f.job.backupId,limit:1});assert.deepEqual(next,{items:[],nextAfter:null});
  await assert.rejects(listRetainedFileBackupGenerations(f.db,principal.ownerId,{limit:51}));
 }finally{await f.mf.dispose();}
});

async function removalPair(){
 const f=await prepared();try{
  const next=await f.admit(),later='2026-10-18T12:01:00.000Z';
  assert.equal((await runScheduledBackup(f.db,principal,next.intentId,{now:()=>later,files:f.services})).status,'completed');
  const sha=(await f.db.prepare('SELECT sha256 FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId).first<{sha256:string}>())!.sha256;
  const newerSha=(await f.db.prepare('SELECT sha256 FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,next.backupId).first<{sha256:string}>())!.sha256;
  return {...f,removalInput:{id:f.job.backupId,sha256:sha,newerId:next.backupId,newerSha256:newerSha},removalAt:'2026-10-18T12:02:00.000Z'};
 }catch(error){await f.mf.dispose();throw error;}
}
test('logical retirement cannot orphan charged retained generations and succeeds only after actual verified cleanup',async()=>{
 const f=await removalPair();try{
  await assert.rejects(prepareFileBackupRemoval(f.db,principal.ownerId,f.removalInput,f.services,f.removalAt),/retained file generations/);
  assert.equal((await f.db.prepare('SELECT status FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId).first<{status:string}>())!.status,'ready');
  assert.equal((await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>f.removalAt,services:f.cleanupServices})).status,'completed');
  const control=await prepareFileBackupRemoval(f.db,principal.ownerId,f.removalInput,f.services,f.removalAt);
  await f.db.batch([...fileBackupRemovalStatements(f.db,principal.ownerId,control,f.removalAt,'1',[],'retained-lifecycle-success'),f.db.prepare('DELETE FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId)]);
  assert.equal((await f.db.prepare('SELECT status FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId).first<{status:string}>())!.status,'retired');
  assert.equal(await f.db.prepare('SELECT 1 FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId).first(),null);
  const newer=await readReadyFileBackup(f.db,principal.ownerId,f.removalInput.newerId,f.services);assert.ok(newer);await newer.stream.cancel();
 }finally{await f.mf.dispose();}
});
test('concurrent retained-generation insertion after removal preparation aborts the whole actual D1 retirement transaction',async()=>{
 const f=await removalPair();try{
  assert.equal((await cleanupRetainedFileBackup(f.db,principal.ownerId,f.input,{now:()=>f.removalAt,services:f.cleanupServices})).status,'completed');
  const control=await prepareFileBackupRemoval(f.db,principal.ownerId,f.removalInput,f.services,f.removalAt);
  const namespace=crypto.randomUUID(),storage=createBackupArchiveStorage(f.services.bucket);
  for(const chunk of f.ready.index.chunks){
   const bytes=await storage.get(f.current,chunk);assert.ok(bytes);await storage.put(namespace,chunk,bytes);
   await f.run('INSERT INTO backup_archive_retained_objects(user_id,storage_key,source_archive_id,part_number,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)',principal.ownerId,backupArchiveKey(namespace,chunk.part),f.job.backupId,chunk.part,namespace,chunk.bytes,chunk.sha256,now,now);
  }
  const before=await readBackupQuotaUsage(f.db,principal.ownerId);
  await assert.rejects(f.db.batch([...fileBackupRemovalStatements(f.db,principal.ownerId,control,f.removalAt,'1',[],'retained-lifecycle-race'),f.db.prepare('DELETE FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId)]));
  assert.equal((await f.db.prepare('SELECT status FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId).first<{status:string}>())!.status,'ready');
  assert.ok(await f.db.prepare('SELECT 1 FROM workspace_backups WHERE user_id=? AND id=?').bind(principal.ownerId,f.job.backupId).first());
  assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),before);assert.ok(await f.bucket.get(backupArchiveKey(namespace,0)));
 }finally{await f.mf.dispose();}
});
