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
import {prepareFileBackupRemoval,fileBackupRemovalStatements,type FileBackupRemovalControl} from '../lib/automations/backup-archive-removal.ts';
import {cleanupRetiredFileBackup,listRetiredFileBackups,type BackupArchiveCleanupBucket} from '../lib/automations/backup-archive-cleanup.ts';
import {runScheduledBackup} from '../lib/automations/backup-store.ts';
import {readReadyFileBackup,type FileBackupServices} from '../lib/automations/backup-archive-store.ts';
import {readBackupQuotaUsage,backupQuotaGuard} from '../lib/backup-archive-quota.ts';
import {readWorkspaceBackup,prepareWorkspaceBackup} from '../lib/workspace-backups.ts';
import {automationScheduleSchema} from '../lib/automations/validation.ts';
import {inspectAttachmentArchive} from '../lib/attachment-archive-import.ts';
import type {BackupArchiveBucket} from '../lib/backup-archive-storage.ts';
const backupPhases=['fixture-bindings','fixture-migrations','fixture-seed','fixture-metadata','fixture-put-start','fixture-put-done','fixture-ready','fixture-failed-dispose','fixture-start','admit','before','run','run-done','workspace-checks','logical','archive','inspect','quota','foreign','replay','dispose','disposed']as const;
function traceBackup(phase:typeof backupPhases[number]){process.stderr.write('SYNTHETIC BACKUP PHASE '+phase+'\n');}
const now='2026-10-18T12:00:00.000Z',principal={ownerId:'synthetic-backup-owner',principalId:'synthetic-backup-principal'};
/** REAL isolated local D1/R2 emulator; private registration below is synthetic fixture authority only. */
async function fixture(options:{fileBytes?:number;fileMode?:boolean;trace?:(phase:typeof backupPhases[number])=>void}={}){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated backup fixture")}}',compatibilityDate:'2026-05-22',d1Databases:['DB'],r2Buckets:['BUCKET']});
 try{
  options.trace?.('fixture-bindings');const native=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
  options.trace?.('fixture-migrations');for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()){
   for(const sql of readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8').split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean))await native.prepare(sql).run();
  }
  const statements=new WeakMap<SqlStatement,ReturnType<typeof native.prepare>>(),texts=new WeakMap<SqlStatement,string>();
  const hooks:{beforeBatch?:(sqls:string[])=>Promise<void>;afterBatch?:(sqls:string[])=>Promise<void>}={};
  const db:SqlDatabase={prepare(sql){let prepared=native.prepare(sql);const statement:SqlStatement={bind(...values){prepared=prepared.bind(...values);statements.set(statement,prepared);return this;},first<T>(){return prepared.first<T>();},all<T>(){return prepared.all<T>();},async run(){const result=await prepared.run();return {meta:{changes:result.meta.changes}};}};statements.set(statement,prepared);texts.set(statement,sql);return statement;},async batch(items){const sqls=items.map(item=>texts.get(item)!);await hooks.beforeBatch?.(sqls);const result=await native.batch(items.map(item=>statements.get(item)!));await hooks.afterBatch?.(sqls);return result.map(item=>({results:item.results,meta:{changes:item.meta.changes}}));}};
  const run=async(sql:string,...values:(string|number|null)[])=>db.prepare(sql).bind(...values).run();
  options.trace?.('fixture-seed');for(const owner of [principal.ownerId,'synthetic-other-owner'])await loadWorkspace(db,owner,()=>workspaceFixture(),now);
  const namespace=(await getWorkspaceNamespaces(db,principal.ownerId))!.blobNamespace,attachmentId=crypto.randomUUID(),bytes=new Uint8Array(options.fileBytes??9*1024*1024).fill(65),sha256=await contentHash(bytes),key='attachments/'+namespace+'/'+attachmentId;
  const record={id:attachmentId,status:'ready',filename:'synthetic-backup-source.txt',mimeType:'text/plain',expectedBytes:bytes.length,actualBytes:bytes.length,sha256,storageKey:key,createdAt:now,expiresAt:'2026-10-18T13:00:00.000Z',readyAt:now,uploadMutationId:'synthetic-source-upload',quarantineReason:null};
  async function put(table:RegisteredOwnerTable,id:string,value:unknown){const columns=moduleColumnNames(table),projection=await moduleProjection(table,id,value as JsonValue),payload=canonical(value);await run('INSERT INTO '+table+'(user_id,id,row_revision,payload_json,content_hash'+columns.map(column=>','+column).join('')+') VALUES(?,?,1,?,?'+columns.map(()=>',?').join('')+')',principal.ownerId,id,payload,await contentHash(payload),...columns.map(column=>projection[column]));}
  options.trace?.('fixture-metadata');await put('attachments',attachmentId,record);await put('attachment_usage','quota',{bytes:bytes.length,files:1});
  await run('INSERT INTO attachment_blob_objects(user_id,storage_key,namespace,attachment_id,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,NULL)',principal.ownerId,key,namespace,attachmentId,bytes.length,sha256,now,now);
  options.trace?.('fixture-put-start');await createR2BlobStore(bucket as AttachmentBucket).put(key,bytes,{bytes:bytes.length,sha256,mimeType:'text/plain'});options.trace?.('fixture-put-done');
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
  options.trace?.('fixture-ready');return {mf,db,bucket,services,hooks,run,admit,count,bytes,record,schedule};
 }catch(error){options.trace?.('fixture-failed-dispose');await mf.dispose();throw error;}
}
// Presence checks must settle native R2 bodies before disposing the isolated worker.
async function assertReadableArchive(...args:Parameters<typeof readReadyFileBackup>){const archive=await readReadyFileBackup(...args);assert.ok(archive);await inspectAttachmentArchive(archive.stream,async()=>{});}
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
 traceBackup('fixture-start');const f=await fixture({trace:traceBackup});try{traceBackup('admit');const job=await f.admit();traceBackup('before');const before=await readCurrent(f.db,principal.ownerId,now);
  traceBackup('run');assert.deepEqual(await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services}),{status:'completed'});traceBackup('run-done');
  traceBackup('workspace-checks');assert.deepEqual(await readCurrent(f.db,principal.ownerId,now),before);assert.equal(await f.count('workspace_backups'),1);assert.equal(await f.count('automation_occurrences'),1);
  traceBackup('logical');const logical=await readWorkspaceBackup(f.db,principal.ownerId,job.backupId);assert.ok(logical);assert.equal(logical.manifest.fileArchive?.status,'ready');assert.equal(logical.manifest.fileArchive?.files,1);assert.equal(logical.bundle.attachments[0].availability,'excluded','metadata JSON never pretends it contains bytes');
  traceBackup('archive');const archive=await readReadyFileBackup(f.db,principal.ownerId,job.backupId,f.services);assert.ok(archive);assert.equal(archive.index.chunks.length,3);assert.ok(archive.index.chunks.every(chunk=>chunk.bytes<=4*1024*1024));
  traceBackup('inspect');const restored:Uint8Array[]=[];const inspected=await inspectAttachmentArchive(archive.stream,async(id,bytes)=>{assert.equal(id,f.record.id);restored.push(bytes);});
  assert.deepEqual(restored,[f.bytes]);assert.equal(inspected.manifest.completeness,'complete');assert.equal(inspected.metadataBundle.source.workspaceRevision,before.revision);assert.equal(inspected.metadataBundle.modules.automation_occurrences.records.length,0);
  traceBackup('quota');const quota=await readBackupQuotaUsage(f.db,principal.ownerId);assert.equal(quota.count,1);assert.equal(quota.bytes,archive.index.zipBytes+logical.manifest.bytes);
  traceBackup('foreign');assert.equal(await readReadyFileBackup(f.db,'synthetic-other-owner',job.backupId,f.services),null);
  traceBackup('replay');assert.deepEqual(await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services}),{status:'replayed'});assert.equal(await f.count('backup_archive_objects'),3);
 }finally{traceBackup('dispose');await f.mf.dispose();traceBackup('disposed');}
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
 const f=await fixture({fileBytes:1024});
 try{
  const job=await f.admit();let raced=false,settledPuts=0,stage='admitted';
  const bucket:BackupArchiveBucket={
   get:key=>f.services.bucket.get(key),
   async put(key,bytes,options){const result=await f.services.bucket.put(key,bytes,options);assert.ok(result);settledPuts++;return result;},
  };
  f.hooks.afterBatch=async sqls=>{
   if(sqls.some(sql=>sql.includes('INSERT INTO backup_archives')))stage='reserved';
   if(sqls.some(sql=>sql.includes('UPDATE backup_archive_objects SET sha256=')))stage='put-admitted';
   if(sqls.some(sql=>sql.includes('UPDATE backup_archive_objects SET verified_at=')))stage='verified';
   if(sqls.some(sql=>sql.includes('UPDATE backup_archives SET index_json=')))stage='indexed';
  };
  f.hooks.beforeBatch=async sqls=>{
   if(raced||!sqls.some(sql=>sql.includes('INSERT INTO workspace_backups')))return;
   // Prove this is the intended terminal boundary after real R2 PUTs and index
   // verification. An earlier preparation failure must fail the race assertion.
   const archive=await f.db.prepare('SELECT status,chunk_count,index_sha256 FROM backup_archives WHERE user_id=? AND id=?').bind(principal.ownerId,job.backupId).first<{status:string;chunk_count:number;index_sha256:string|null}>();
   assert.ok(archive);assert.equal(archive.status,'preparing');assert.match(archive.index_sha256??'',/^[a-f0-9]{64}$/u);
   const objects=await f.db.prepare('SELECT COUNT(*) total,SUM(CASE WHEN pending_token IS NOT NULL AND settled_at IS NOT NULL AND verified_at IS NOT NULL AND purged_at IS NULL THEN 1 ELSE 0 END) verified FROM backup_archive_objects WHERE user_id=? AND archive_id=?').bind(principal.ownerId,job.backupId).first<{total:number;verified:number}>();
   assert.ok(objects);assert.ok(settledPuts>0);assert.equal(settledPuts,archive.chunk_count);assert.equal(objects.total,archive.chunk_count);assert.equal(objects.verified,archive.chunk_count);assert.equal(stage,'indexed');
   await f.run('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?)',principal.ownerId,now);raced=true;
  };
  const result=await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:{...f.services,bucket}});
  assert.equal(raced,true,canonical({status:result.status,reason:result.reason??null,settledPuts,stage}));
  assert.deepEqual(result,{status:'conflict'});
  assert.equal(await f.count('workspace_backups'),0);assert.equal(await f.count('automation_occurrences'),0);
  assert.equal((await f.db.prepare('SELECT status FROM backup_archives').first<{status:string}>())!.status,'preparing');
  assert.equal((await f.db.prepare('SELECT last_success_at FROM automation_runtime').first<{last_success_at:string|null}>())!.last_success_at,null);
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

const removalNow='2026-10-18T12:02:00.000Z';
async function pair(f:Awaited<ReturnType<typeof fixture>>){
 const selected=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,selected.intentId,{now:()=>now,files:f.services})).status,'completed');
 const newer=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,newer.intentId,{now:()=> '2026-10-18T12:00:01.000Z',files:f.services})).status,'completed');
 const old=await readWorkspaceBackup(f.db,principal.ownerId,selected.backupId),next=await readWorkspaceBackup(f.db,principal.ownerId,newer.backupId);assert.ok(old&&next);
 return {selected,newer,input:{id:selected.backupId,sha256:old.manifest.sha256,newerId:newer.backupId,newerSha256:next.manifest.sha256}};
}
async function compileRemoval(f:Awaited<ReturnType<typeof fixture>>,proof:FileBackupRemovalControl){
 const mutationId='synthetic-file-removal-'+crypto.randomUUID(),token=crypto.randomUUID(),binds=[principal.ownerId,mutationId,token],gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)';
 await f.db.batch([
 f.db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...binds),
 ...fileBackupRemovalStatements(f.db,principal.ownerId,proof,removalNow,gate,binds,mutationId),
 f.db.prepare('DELETE FROM workspace_backups WHERE user_id=? AND id=? AND sha256=? AND '+gate).bind(principal.ownerId,proof.selected.logical.id,proof.selected.logical.sha256,...binds),
 f.db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(principal.ownerId,mutationId),
 f.db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...binds)
 ]);
}
test('explicit pinned file-point removal requires actual newer full archive and atomically retains permanent physical identities',async()=>{
 const f=await fixture({fileBytes:1024});try{const points=await pair(f);
 await assert.rejects(prepareFileBackupRemoval(f.db,principal.ownerId,{...points.input,newerId:points.selected.backupId,newerSha256:points.input.sha256},f.services,removalNow));
 await assert.rejects(prepareFileBackupRemoval(f.db,'synthetic-other-owner',points.input,f.services,removalNow));
 await f.run('UPDATE workspace_backups SET pinned=1 WHERE id=?',points.selected.backupId);const before=await readCurrent(f.db,principal.ownerId,now),proof=await prepareFileBackupRemoval(f.db,principal.ownerId,points.input,f.services,removalNow);
 assert.equal(proof.selected.logical.pinned,1);await compileRemoval(f,proof);
 assert.deepEqual(await readCurrent(f.db,principal.ownerId,now),before);assert.equal(await readWorkspaceBackup(f.db,principal.ownerId,points.selected.backupId),null);await assertReadableArchive(f.db,principal.ownerId,points.newer.backupId,f.services);
 const row=await f.db.prepare('SELECT status,metadata_content,metadata_bytes,index_sha256 FROM backup_archives WHERE id=?').bind(points.selected.backupId).first<{status:string;metadata_content:string|null;metadata_bytes:number;index_sha256:string}>();
 assert.deepEqual(row,{status:'retired',metadata_content:null,metadata_bytes:0,index_sha256:proof.selected.archive.index_sha256});
 const listed=await listRetiredFileBackups(f.db,principal.ownerId,{limit:1});assert.equal(listed.items[0].id,points.selected.backupId);assert.ok(listed.items[0].chargedBytes>0);assert.ok(!canonical(listed).includes(proof.selected.archive.namespace));assert.ok(!canonical(listed).includes(principal.ownerId));assert.equal((await listRetiredFileBackups(f.db,'synthetic-other-owner')).items.length,0);
 let deletes=0;const bucket:BackupArchiveCleanupBucket={get:key=>f.services.bucket.get(key),put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),async delete(key){deletes++;await f.bucket.delete(key);}};
 await assert.rejects(cleanupRetiredFileBackup(f.db,principal.ownerId,{id:points.newer.backupId,indexHash:proof.newer.archive.index_sha256},{now:()=>now,bucket}));assert.equal(deletes,0,'a ready point cannot become a cleanup target');
 const quota=await readBackupQuotaUsage(f.db,principal.ownerId),cleaned=await cleanupRetiredFileBackup(f.db,principal.ownerId,{id:points.selected.backupId,indexHash:proof.selected.archive.index_sha256},{now:()=>now,bucket});
 assert.equal(cleaned.status,'completed');assert.equal(cleaned.retainedBytes,0);assert.equal(cleaned.physicalDeletion,true);assert.equal(deletes,proof.selected.objects.length);assert.equal((await readBackupQuotaUsage(f.db,principal.ownerId)).bytes,quota.bytes-proof.selected.archive.zip_bytes);
 assert.equal(await f.count('backup_archive_cleanup_claims'),proof.selected.objects.length);assert.equal(await f.count('backup_archive_objects'),proof.selected.objects.length+proof.newer.objects.length,'physical identities are never deleted/reused');
 await assertReadableArchive(f.db,principal.ownerId,points.newer.backupId,f.services);
 }finally{await f.mf.dispose();}
});
test('changed newer physical ledger or corrupted newer bytes cannot retire the selected point',async()=>{
 const f=await fixture({fileBytes:1024});try{const points=await pair(f),proof=await prepareFileBackupRemoval(f.db,principal.ownerId,points.input,f.services,removalNow);let raced=false;
 f.hooks.beforeBatch=async sqls=>{if(!raced&&sqls.some(sql=>sql.includes("UPDATE backup_archives SET status='retired'"))){raced=true;await f.run('UPDATE backup_archive_objects SET verified_at=NULL WHERE archive_id=?',points.newer.backupId);}};
 await assert.rejects(compileRemoval(f,proof));f.hooks.beforeBatch=undefined;assert.equal((await f.db.prepare('SELECT status FROM backup_archives WHERE id=?').bind(points.selected.backupId).first<{status:string}>())!.status,'ready');assert.equal(await f.count('workspace_backups'),2);
 await f.run('UPDATE backup_archive_objects SET verified_at=? WHERE archive_id=?',now,points.newer.backupId);
 const object=proof.newer.objects[0];await f.bucket.put(object.storage_key,new Uint8Array(object.bytes).fill(66),{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:object.sha256}});
 await assert.rejects(prepareFileBackupRemoval(f.db,principal.ownerId,points.input,f.services,removalNow));assert.equal(await f.count('workspace_backups'),2);assert.equal(await f.count('backup_archive_cleanup_claims'),0);
 }finally{await f.mf.dispose();}
});
test('unknown DELETE preserves its fence and charge; explicit absence reconciliation never targets a fresh namespace',async()=>{
 const f=await fixture({fileBytes:1024});try{const points=await pair(f),proof=await prepareFileBackupRemoval(f.db,principal.ownerId,points.input,f.services,removalNow);await compileRemoval(f,proof);
 let deletes=0;const bucket:BackupArchiveCleanupBucket={get:key=>f.services.bucket.get(key),put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),async delete(key){deletes++;await f.bucket.delete(key);throw new Error('synthetic response lost after actual DELETE');}};
 const initial=await readBackupQuotaUsage(f.db,principal.ownerId),unknown=await cleanupRetiredFileBackup(f.db,principal.ownerId,{id:points.selected.backupId,indexHash:proof.selected.archive.index_sha256},{now:()=>now,bucket});assert.equal(unknown.status,'uncertain');assert.equal(unknown.physicalDeletion,false);assert.equal((await readBackupQuotaUsage(f.db,principal.ownerId)).bytes,initial.bytes);
 const fresh=await f.admit();assert.equal((await runScheduledBackup(f.db,principal,fresh.intentId,{now:()=> '2026-10-18T12:00:02.000Z',files:f.services})).status,'completed');
 const recovered=await cleanupRetiredFileBackup(f.db,principal.ownerId,{id:points.selected.backupId,indexHash:proof.selected.archive.index_sha256},{now:()=>now,bucket});assert.equal(recovered.status,'completed');assert.equal(recovered.retainedBytes,0);assert.equal(deletes,1,'actual missing object reconciles without a second DELETE');
 await f.bucket.delete(proof.selected.objects[0].storage_key);await assertReadableArchive(f.db,principal.ownerId,fresh.backupId,f.services);await assertReadableArchive(f.db,principal.ownerId,points.newer.backupId,f.services);
 const freshNamespace=(await f.db.prepare('SELECT namespace FROM backup_archives WHERE id=?').bind(fresh.backupId).first<{namespace:string}>())!.namespace;assert.notEqual(freshNamespace,proof.selected.archive.namespace);assert.equal(await f.count('backup_archive_cleanup_claims'),1);
 }finally{await f.mf.dispose();}
});

test('hung DELETE is bounded and fenced; an existing unknown operation never starts a second DELETE',async()=>{
 const f=await fixture({fileBytes:1024}),operation:{finish?:()=>Promise<void>}={};try{const points=await pair(f),proof=await prepareFileBackupRemoval(f.db,principal.ownerId,points.input,f.services,removalNow);await compileRemoval(f,proof);
 let deletes=0;const bucket:BackupArchiveCleanupBucket={get:key=>f.services.bucket.get(key),put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),delete(key){deletes++;return new Promise<void>(resolve=>{operation.finish=async()=>{await f.bucket.delete(key);resolve();};});}};
 const command={id:points.selected.backupId,indexHash:proof.selected.archive.index_sha256},initial=await readBackupQuotaUsage(f.db,principal.ownerId);
 const hung=await cleanupRetiredFileBackup(f.db,principal.ownerId,command,{now:()=>removalNow,bucket,deleteDeadlineMs:5});assert.equal(hung.status,'uncertain');assert.equal(hung.physicalDeletion,false);assert.equal(deletes,1);assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),initial);
 const repeat=await cleanupRetiredFileBackup(f.db,principal.ownerId,command,{now:()=>removalNow,bucket,deleteDeadlineMs:5});assert.equal(repeat.status,'uncertain');assert.equal(deletes,1);
 assert.ok(operation.finish);await operation.finish();operation.finish=undefined;
 const reconciled=await cleanupRetiredFileBackup(f.db,principal.ownerId,command,{now:()=>removalNow,bucket,deleteDeadlineMs:5});assert.equal(reconciled.status,'completed');assert.equal(reconciled.retainedBytes,0);assert.equal(deletes,1);await assertReadableArchive(f.db,principal.ownerId,points.newer.backupId,f.services);
 }finally{try{await operation.finish?.();}finally{await f.mf.dispose();}}
});

test('historical retired continuity is not current DELETE authority after an execution epoch advance',async()=>{
 const f=await fixture({fileBytes:1024});try{const points=await pair(f);await f.run('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?)',principal.ownerId,removalNow);
 const proof=await prepareFileBackupRemoval(f.db,principal.ownerId,points.input,f.services,removalNow);assert.equal(proof.executionEpoch,1);await compileRemoval(f,proof);
 assert.equal((await f.db.prepare('SELECT execution_epoch FROM backup_archives WHERE id=?').bind(points.selected.backupId).first<{execution_epoch:number}>())!.execution_epoch,1,'only this fresh protected owner action grants retirement authority at current epoch');
 await f.run('UPDATE workspace_execution_state SET epoch=2 WHERE user_id=?',principal.ownerId);
 let deletes=0;const bucket:BackupArchiveCleanupBucket={get:key=>f.services.bucket.get(key),put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),async delete(key){deletes++;await f.bucket.delete(key);}};
 const before=await readBackupQuotaUsage(f.db,principal.ownerId),cleaned=await cleanupRetiredFileBackup(f.db,principal.ownerId,{id:points.selected.backupId,indexHash:proof.selected.archive.index_sha256},{now:()=>removalNow,bucket});
 assert.equal(cleaned.status,'blocked');assert.equal(cleaned.reason,'authorization_stale');assert.equal(cleaned.physicalDeletion,false);assert.equal(deletes,0);assert.equal(await f.count('backup_archive_cleanup_claims'),0);assert.deepEqual(await readBackupQuotaUsage(f.db,principal.ownerId),before);
 assert.equal((await listRetiredFileBackups(f.db,principal.ownerId)).items[0].cleanupAuthorized,false);
 }finally{await f.mf.dispose();}
});

test('a replayed native file backup settles its cancelled verification GET before returning',async()=>{
 const f=await fixture({fileBytes:1024});
 let release!:()=>void,entered!:()=>void,drained!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),finished=new Promise<void>(resolve=>{drained=resolve;});
 let replay:ReturnType<typeof runScheduledBackup>|undefined,gated=false;
 try{
  const job=await f.admit();assert.deepEqual(await runScheduledBackup(f.db,principal,job.intentId,{now:()=>now,files:f.services}),{status:'completed'});
  const key=(await f.db.prepare('SELECT storage_key FROM backup_archive_objects WHERE user_id=? AND archive_id=? AND part_number=0').bind(principal.ownerId,job.backupId).first<{storage_key:string}>())!.storage_key;
  let gets=0,verificationPullStarted=false,bodySettled=false,postPullReads=0;
  const db:SqlDatabase={prepare(sql){if(verificationPullStarted&&!bodySettled)postPullReads++;return f.db.prepare(sql);},batch(items){return f.db.batch(items);}};
  const services:FileBackupServices={...f.services,bucket:{put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),async get(requested){
   const verificationPull=requested===key&&++gets===2;if(verificationPull)verificationPullStarted=true;
   const object=await f.services.bucket.get(requested);if(!object||!verificationPull)return object;
   // The first GET verifies the complete archive; the second is the returned
   // stream's automatic pull. Retain its ACTUAL R2 body until explicit release.
   gated=true;const reader=object.body.getReader();let first=true,closed=false;
   return {size:object.size,httpMetadata:object.httpMetadata,customMetadata:object.customMetadata,body:new ReadableStream<Uint8Array>({
    async pull(controller){try{if(first){first=false;entered();await gate;}const next=await reader.read();if(next.done){closed=true;reader.releaseLock();bodySettled=true;drained();controller.close();}else controller.enqueue(next.value);}catch(error){if(!closed){closed=true;reader.releaseLock();bodySettled=true;drained();}controller.error(error);}},
    async cancel(){try{release();await reader.cancel();}finally{if(!closed){closed=true;reader.releaseLock();bodySettled=true;drained();}}}
   })};
  }}};
  let settled=false;replay=runScheduledBackup(db,principal,job.intentId,{now:()=>now,files:services});void replay.then(()=>{settled=true;},()=>{settled=true;});
  await started;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(postPullReads,0,'verification body ownership must settle before subsequent owner proof reads');assert.equal(settled,false,'a receipt is not returned while its cancelled native GET still owns an unread body');
  release();assert.deepEqual(await replay,{status:'replayed'});await finished;assert.equal(gets,2);
  assert.equal(await f.count('workspace_backups'),1);assert.equal(await f.count('automation_occurrences'),1);assert.equal(await f.count('backup_archive_objects'),1);
 }finally{release();if(gated)await finished;await replay?.catch(()=>{});await f.mf.dispose();}
});

test('a reviewed file-removal preflight settles its cancelled verification GET before returning',async()=>{
 const f=await fixture({fileBytes:1024});
 let release!:()=>void,entered!:()=>void,drained!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),finished=new Promise<void>(resolve=>{drained=resolve;});
 let removal:ReturnType<typeof prepareFileBackupRemoval>|undefined,gated=false;
 try{
  const points=await pair(f);
  const key=(await f.db.prepare('SELECT storage_key FROM backup_archive_objects WHERE user_id=? AND archive_id=? AND part_number=0').bind(principal.ownerId,points.newer.backupId).first<{storage_key:string}>())!.storage_key;
  let gets=0,verificationPullStarted=false,bodySettled=false,postPullReads=0;
  const db:SqlDatabase={prepare(sql){if(verificationPullStarted&&!bodySettled)postPullReads++;return f.db.prepare(sql);},batch(items){return f.db.batch(items);}};
  const services:FileBackupServices={...f.services,bucket:{put:(key,bytes,options)=>f.services.bucket.put(key,bytes,options),async get(requested){
   const verificationPull=requested===key&&++gets===2;if(verificationPull)verificationPullStarted=true;
   const object=await f.services.bucket.get(requested);if(!object||!verificationPull)return object;
   // The first GET verifies the complete archive; the second is the returned
   // stream's automatic pull. Retain its ACTUAL R2 body until explicit release.
   gated=true;const reader=object.body.getReader();let first=true,closed=false;
   return {size:object.size,httpMetadata:object.httpMetadata,customMetadata:object.customMetadata,body:new ReadableStream<Uint8Array>({
    async pull(controller){try{if(first){first=false;entered();await gate;}const next=await reader.read();if(next.done){closed=true;reader.releaseLock();bodySettled=true;drained();controller.close();}else controller.enqueue(next.value);}catch(error){if(!closed){closed=true;reader.releaseLock();bodySettled=true;drained();}controller.error(error);}},
    async cancel(){try{release();await reader.cancel();}finally{if(!closed){closed=true;reader.releaseLock();bodySettled=true;drained();}}}
   })};
  }}};
  let settled=false;removal=prepareFileBackupRemoval(db,principal.ownerId,points.input,services,removalNow);void removal.then(()=>{settled=true;},()=>{settled=true;});
  await started;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(postPullReads,0,'verification body ownership must settle before subsequent owner proof reads');assert.equal(settled,false,'reviewed removal proof is not returned while its cancelled native GET still owns an unread body');
  release();assert.equal((await removal).selected.logical.id,points.selected.backupId);await finished;assert.equal(gets,2);
  assert.equal(await f.count('workspace_backups'),2);assert.equal(await f.count('backup_archive_cleanup_claims'),0);assert.equal(await f.count('backup_archive_objects'),2);
 }finally{release();if(gated)await finished;await removal?.catch(()=>{});await f.mf.dispose();}
});
