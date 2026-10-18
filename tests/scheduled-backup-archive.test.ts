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
import {readWorkspaceBackup,prepareWorkspaceBackup} from '../lib/workspace-backups.ts';
import {automationScheduleSchema} from '../lib/automations/validation.ts';
import {inspectAttachmentArchive} from '../lib/attachment-archive-import.ts';
import type {BackupArchiveBucket} from '../lib/backup-archive-storage.ts';
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
  const db:SqlDatabase={prepare(sql){let prepared=native.prepare(sql);const statement:SqlStatement={bind(...values){prepared=prepared.bind(...values);statements.set(statement,prepared);return this;},first<T>(){return prepared.first<T>();},all<T>(){return prepared.all<T>();},async run(){const result=await prepared.run();return {meta:{changes:result.meta.changes}};}};statements.set(statement,prepared);texts.set(statement,sql);return statement;},async batch(items){const sqls=items.map(item=>texts.get(item)!);await hooks.beforeBatch?.(sqls);const result=await native.batch(items.map(item=>statements.get(item)!));await hooks.afterBatch?.(sqls);return result.map(item=>({meta:{changes:item.meta.changes}}));}};
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
test('strict explicit schedule file consent has no legacy defaults or cross-kind grants',()=>{
 const base={id:'synthetic-schedule',kind:'backup',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'09:00'},sourceId:null,projectIds:[],catchUp:'latest_only',createdAt:now,updatedAt:now,archivedAt:null};
 assert.equal(automationScheduleSchema.safeParse(base).success,true);assert.equal('backupMode' in automationScheduleSchema.parse(base),false);
 assert.equal(automationScheduleSchema.safeParse({...base,backupMode:'files'}).success,false);
 assert.equal(automationScheduleSchema.safeParse({...base,backupMode:'files',fileBackupConsent:true}).success,true);
 assert.equal(automationScheduleSchema.safeParse({...base,backupMode:'metadata',fileBackupConsent:false}).success,true);
 assert.equal(automationScheduleSchema.safeParse({...base,backupMode:'metadata',fileBackupConsent:true}).success,false);
 assert.equal(automationScheduleSchema.safeParse({...base,kind:'daily_review',backupMode:'files',fileBackupConsent:true}).success,false);
});
test('actual isolated D1/R2 file backup stores multiple immutable chunks and downloads a complete exact native ZIP',async()=>{
 const f=await fixture();try{const job=await f.admit(),before=await readCurrent(f.db,principal.ownerId,now);
  assert.deepEqual(await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services}),{status:'completed'});
  assert.deepEqual(await readCurrent(f.db,principal.ownerId,now),before);assert.equal(await f.count('workspace_backups'),1);assert.equal(await f.count('automation_occurrences'),1);
  const logical=await readWorkspaceBackup(f.db,principal.ownerId,job.backupId);assert.ok(logical);assert.equal(logical.manifest.fileArchive?.status,'ready');assert.equal(logical.manifest.fileArchive?.files,1);assert.equal(logical.bundle.attachments[0].availability,'excluded','metadata JSON never pretends it contains bytes');
  const archive=await readReadyFileBackup(f.db,principal.ownerId,job.backupId,f.services);assert.ok(archive);assert.equal(archive.index.chunks.length,3);assert.ok(archive.index.chunks.every(chunk=>chunk.bytes<=4*1024*1024));
  const restored:Uint8Array[]=[];const inspected=await inspectAttachmentArchive(archive.stream,async(id,bytes)=>{assert.equal(id,f.record.id);restored.push(bytes);});
  assert.deepEqual(restored,[f.bytes]);assert.equal(inspected.manifest.completeness,'complete');assert.equal(inspected.metadataBundle.source.workspaceRevision,before.revision);assert.equal(inspected.metadataBundle.modules.automation_occurrences.records.length,0);
  const quota=await readBackupQuotaUsage(f.db,principal.ownerId);assert.equal(quota.count,1);assert.equal(quota.bytes,archive.index.zipBytes+logical.manifest.bytes);
  assert.equal(await readReadyFileBackup(f.db,'synthetic-other-owner',job.backupId,f.services),null);
  assert.deepEqual(await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services}),{status:'replayed'});assert.equal(await f.count('backup_archive_objects'),3);
 }finally{await f.mf.dispose();}
});
test('missing binding, wrong principal and revoked registration cannot write objects or fabricate metadata fallback',async()=>{
 const f=await fixture({fileBytes:1024});try{const job=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now})).status,'blocked');
  assert.equal((await runScheduledBackup(f.db,{...principal,principalId:'synthetic-foreign-principal'},job.intentId,{now:()=>now,files:f.services})).status,'blocked');
  await f.run('UPDATE integration_service_principals SET revoked_at=?',now);assert.equal((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services})).status,'blocked');
  assert.equal(await f.count('workspace_backups'),0);assert.equal(await f.count('backup_archives'),0);assert.equal(await f.count('backup_archive_objects'),0);
 }finally{await f.mf.dispose();}
});
test('unknown PUT response retains charged pending token and retry reconciles existing bytes without duplicate PUT',async()=>{
 const f=await fixture();try{const job=await f.admit();let putCount=0,lose=true;const bucket:BackupArchiveBucket={get:key=>f.services.bucket.get(key),async put(key,bytes,options){putCount++;const stored=await f.services.bucket.put(key,bytes,options);if(lose){lose=false;throw new Error('synthetic lost PUT response');}return stored;}},services={...f.services,bucket};
  assert.equal((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:services})).status,'uncertain');assert.equal(await f.count('workspace_backups'),0);
  const pending=await f.db.prepare('SELECT pending_token,settled_at FROM backup_archive_objects WHERE part_number=0').first<{pending_token:string|null;settled_at:string|null}>();assert.ok(pending?.pending_token);assert.equal(pending.settled_at,null);
  const charged=await readBackupQuotaUsage(f.db,principal.ownerId);assert.ok(charged.bytes>f.bytes.length);
  assert.deepEqual(await runScheduledBackup(f.db,principal,job.intentId,{now:()=> '2026-10-18T12:00:31.000Z',files:services}),{status:'completed'});assert.equal(putCount,3,'first immutable part was recovered by GET, not PUT twice');assert.equal((await f.db.prepare('SELECT settled_at FROM backup_archive_objects WHERE part_number=0').first<{settled_at:string|null}>())!.settled_at,null,'unknown original operation is never clock-expired');
  assert.equal((await readWorkspaceBackup(f.db,principal.ownerId,job.backupId))!.manifest.fileArchive!.status,'ready');
 }finally{await f.mf.dispose();}
});
test('corrupt or missing source/object bytes never produce a ready recovery point',async()=>{
 const f=await fixture({fileBytes:1024});try{const job=await f.admit();await f.bucket.delete(f.record.storageKey);assert.notEqual((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services})).status,'completed');assert.equal(await f.count('workspace_backups'),0);assert.equal(await f.count('automation_occurrences'),0);assert.ok((await readBackupQuotaUsage(f.db,principal.ownerId)).bytes>0);
 }finally{await f.mf.dispose();}
 const g=await fixture({fileBytes:1024});try{const job=await g.admit();assert.equal((await runScheduledBackup(g.db,principal,job.intentId,{now:()=>now,files:g.services})).status,'completed');
  const object=await g.db.prepare('SELECT storage_key,sha256,bytes FROM backup_archive_objects WHERE part_number=0').first<{storage_key:string;sha256:string;bytes:number}>();assert.ok(object);await g.bucket.put(object.storage_key,new Uint8Array(object.bytes).fill(66),{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:object.sha256}});
  await assert.rejects(readReadyFileBackup(g.db,principal.ownerId,job.backupId,g.services));assert.equal((await runScheduledBackup(g.db,principal,job.intentId,{now:()=>now,files:g.services})).status,'uncertain');
 }finally{await g.mf.dispose();}
});
test('terminal epoch race cannot publish archive/backup/occurrence success after physical PUTs',async()=>{
 const f=await fixture({fileBytes:1024});try{const job=await f.admit();let raced=false;f.hooks.beforeBatch=async sqls=>{if(!raced&&sqls.some(sql=>sql.includes('INSERT INTO workspace_backups'))){raced=true;await f.run('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?)',principal.ownerId,now);}};
  assert.notEqual((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services})).status,'completed');assert.equal(raced,true);assert.equal(await f.count('workspace_backups'),0);assert.equal(await f.count('automation_occurrences'),0);assert.equal((await f.db.prepare('SELECT status FROM backup_archives').first<{status:string}>())!.status,'preparing');assert.equal((await f.db.prepare('SELECT last_success_at FROM automation_runtime').first<{last_success_at:string|null}>())!.last_success_at,null);
 }finally{await f.mf.dispose();}
});
test('retained file bytes count against the same 20MB owner quota and no pinned/manual point is evicted',async()=>{
 const f=await fixture();try{const manual=await prepareWorkspaceBackup(f.db,principal.ownerId,await readCurrent(f.db,principal.ownerId,now),'manual',now);await f.run("INSERT INTO workspace_backups(user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES(?,?,?,?,'manual',?,?,?,'ready',1)",principal.ownerId,'synthetic-manual-point',manual.manifest.sourceRevision,now,manual.manifest.bytes,manual.manifest.sha256,manual.content);for(let index=0;index<2;index++){const job=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services})).status,'completed');}
  const before=await readBackupQuotaUsage(f.db,principal.ownerId),third=await f.admit();assert.deepEqual(await runScheduledBackup(f.db,principal,third.intentId,{now:()=>now,files:f.services}),{status:'blocked',reason:'storage_capacity'});assert.equal(await f.count('workspace_backups'),3);assert.equal(await f.count('backup_archives'),2);assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),before);
  const guard=backupQuotaGuard(principal.ownerId,3_000_000,1);assert.equal(await f.db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first(),null);assert.equal((await f.db.prepare('SELECT pinned FROM workspace_backups WHERE id=?').bind('synthetic-manual-point').first<{pinned:number}>())!.pinned,1);assert.equal((await readWorkspaceBackup(f.db,principal.ownerId,'synthetic-manual-point'))!.content,manual.content);
 }finally{await f.mf.dispose();}
});

test('a missing object with unknown pending PUT is not blindly retried after lease expiry',async()=>{
 const f=await fixture({fileBytes:1024});try{const job=await f.admit();let puts=0;const services={...f.services,bucket:{get:(key:string)=>f.services.bucket.get(key),async put(){puts++;throw new Error('synthetic unconfirmed PUT before visible object');}}};
 assert.equal((await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:services})).status,'uncertain');const before=await readBackupQuotaUsage(f.db,principal.ownerId);
 assert.equal((await runScheduledBackup(f.db,principal,job.intentId,{now:()=> '2026-10-18T12:00:31.000Z',files:services})).status,'uncertain');assert.equal(puts,1);assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),before);assert.equal(await f.count('workspace_backups'),0);assert.equal((await f.db.prepare('SELECT settled_at FROM backup_archive_objects').first<{settled_at:string|null}>())!.settled_at,null);
 }finally{await f.mf.dispose();}
});
test('lost terminal response reconciles the same verified archive without another PUT or duplicate history',async()=>{
 const f=await fixture({fileBytes:1024});try{const job=await f.admit();let lost=false;f.hooks.afterBatch=async sqls=>{if(!lost&&sqls.some(sql=>sql.includes('INSERT INTO workspace_backups'))){lost=true;throw new Error('synthetic lost terminal response');}};
 assert.deepEqual(await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services}),{status:'replayed'});assert.equal(await f.count('workspace_backups'),1);assert.equal(await f.count('automation_occurrences'),1);assert.equal((await readWorkspaceBackup(f.db,principal.ownerId,job.backupId))!.manifest.fileArchive!.status,'ready');
 }finally{await f.mf.dispose();}
});
