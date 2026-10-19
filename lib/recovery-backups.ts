import type {SqlDatabase} from './workspace-store.ts';
import {readBackupQuotaUsage,backupQuotaGuard} from './backup-archive-quota.ts';
import {BACKUP_LIMITS} from './workspace-backups.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {readReadyFileBackup,type FileBackupServices} from './automations/backup-archive-store.ts';
import {createBackupArchiveStorage,backupArchiveKey,type BackupArchiveBucket} from './backup-archive-storage.ts';
import {inactiveRecoveryDatabase} from './recovery-install.ts';
import {bindFrozenPrivateContinuity,type RecoveryMaintenanceReceipt} from './recovery-maintenance.ts';
import type {RecoveryPrivateContinuity} from './recovery-private-continuity.ts';
type Row=Record<string,string|number|null>;
/**
 * Privileged frozen-source adapter. JSON supplies no bucket keys or authority:
 * source metadata is independently recaptured under the actual maintenance lock.
 * No physical deletes, credentials, public links or binding cutover are created.
 */
export async function copyRecoveryBackupArchives(source:SqlDatabase,sourceReceipt:RecoveryMaintenanceReceipt,
 target:SqlDatabase,targetReceipt:RecoveryMaintenanceReceipt,continuity:RecoveryPrivateContinuity,
 services:{source:FileBackupServices;targetBucket:BackupArchiveBucket;signal?:AbortSignal}){
 const snapshot=structuredClone(continuity);
 await bindFrozenPrivateContinuity(source,sourceReceipt,snapshot,snapshot.sha256);
 const owner=sourceReceipt.ownerId;
 if(targetReceipt.ownerId!==owner||targetReceipt.manifestSha256!==sourceReceipt.manifestSha256||
  targetReceipt.ownerContextHash!==sourceReceipt.ownerContextHash||canonical(targetReceipt.sourceContext)!==canonical(sourceReceipt.sourceContext))
  throw new Error('Backup source/target recovery identity differs.');
 const db=inactiveRecoveryDatabase(target,targetReceipt),sourceStorage=createBackupArchiveStorage(services.source.bucket),targetStorage=createBackupArchiveStorage(services.targetBucket);
 async function insert(table:string,row:Row){
  const columns=Object.keys(row);if(!/^[a-z_][a-z0-9_]*$/.test(table)||columns.some(column=>!/^[a-z_][a-z0-9_]*$/.test(column)))throw new Error('Invalid closed backup projection.');
  await db.prepare('INSERT INTO '+table+'(user_id,'+columns.join(',')+') VALUES('+['user_id',...columns].map(()=>'?').join(',')+')').bind(owner,...columns.map(column=>row[column])).run();
 }
 // The type is expanded only with the reviewed physical-column schemas. A
 // package from an older profile cannot silently omit logical backup history.
 const tables=snapshot.tables as unknown as Record<string,Row[]>;
 if(!Array.isArray(tables.workspace_backups)||!Array.isArray(tables.backup_archive_cleanup_claims)||!Array.isArray(tables.backup_archive_retained_objects))
  throw new Error('Complete logical backup and permanent cleanup continuity is required.');
 const sourceUsage=await readBackupQuotaUsage(source,owner),additionalBytes=snapshot.tables.backup_archives.filter(archive=>archive.status==='ready').reduce((sum,archive)=>sum+archive.zip_bytes,0);
 if(sourceUsage.count>BACKUP_LIMITS.snapshots||sourceUsage.bytes+additionalBytes>BACKUP_LIMITS.ownerBytes)throw new Error('Recovery backup generation copies exceed physical quota headroom.');
 for(const retained of tables.backup_archive_retained_objects)await insert('backup_archive_retained_objects',retained);
 for(const original of snapshot.tables.backup_archives.filter(archive=>archive.status==='ready'))for(const object of snapshot.tables.backup_archive_objects.filter(object=>object.archive_id===original.id)){
  if(object.verified_at===null||object.sha256===null||object.purged_at!==null||object.pending_token!==null&&object.settled_at===null)throw new Error('Old ready backup generation is not verified and settled.');
  await insert('backup_archive_retained_objects',{storage_key:object.storage_key,source_archive_id:original.id,part_number:object.part_number,namespace:original.namespace,bytes:object.bytes,sha256:object.sha256,created_at:object.created_at,verified_at:object.verified_at,purged_at:object.purged_at});
 }
 for(const logical of tables.workspace_backups)await insert('workspace_backups',logical);
 for(const claim of tables.backup_archive_cleanup_claims)await insert('backup_archive_cleanup_claims',claim);
 const mappings:{archiveId:string;sourceNamespace:string;targetNamespace:string;indexSha256:string}[]=[];
 for(const original of snapshot.tables.backup_archives.filter(archive=>archive.status!=='ready')){
  await insert('backup_archives',original);
  for(const object of snapshot.tables.backup_archive_objects.filter(object=>object.archive_id===original.id))await insert('backup_archive_objects',object);
 }
 for(const original of snapshot.tables.backup_archives.filter(archive=>archive.status==='ready')){
  const objects=snapshot.tables.backup_archive_objects.filter(object=>object.archive_id===original.id);
  if(objects.some(object=>object.pending_token!==null&&object.settled_at===null))throw new Error('Unsettled source backup PUT cannot be copied.');
  for(const object of objects){
   if(await source.prepare('SELECT 1 FROM backup_archive_cleanup_claims WHERE storage_key=?').bind(object.storage_key).first())
    throw new Error('Fenced source backup object cannot be advertised as ready.');
  }
  const verified=await readReadyFileBackup(source,owner,original.id,services.source,services.signal);
  if(!verified)throw new Error('Ready source archive is unavailable or differs.');
  await verified.stream.cancel();
  if(verified.indexHash!==original.index_sha256)throw new Error('Ready source archive is unavailable or differs.');
  const namespace=crypto.randomUUID(),row={...original,namespace,status:'preparing'};
  await insert('backup_archives',row);
  for(const descriptor of verified.index.chunks){
   const bytes=await sourceStorage.get(original.namespace,descriptor,services.signal);
   if(!bytes)throw new Error('Frozen source backup chunk is unavailable.');
   const token=crypto.randomUUID(),storageKey=backupArchiveKey(namespace,descriptor.part);
   const object={archive_id:original.id,part_number:descriptor.part,storage_key:storageKey,bytes:descriptor.bytes,sha256:descriptor.sha256,created_at:sourceReceipt.createdAt,verified_at:null,purged_at:null,pending_token:token,settled_at:null};
   const guard=backupQuotaGuard(owner,descriptor.bytes,0),columns=Object.keys(object),values=columns.map(column=>object[column as keyof typeof object]);
   const reserved=await db.prepare('INSERT INTO backup_archive_objects(user_id,'+columns.join(',')+') SELECT '+['user_id',...columns].map(()=>'?').join(',')+' WHERE '+guard.sql).bind(owner,...values,...guard.bindings).run();
   if(reserved.meta.changes!==1)throw new Error('Recovery backup generation quota reservation failed.');
   // Ambiguous rejection leaves the persisted token unsettled and destination
   // inactive. No retry overwrite or clock-based token settlement is allowed.
   await targetStorage.put(namespace,descriptor,bytes);
   await db.prepare('UPDATE backup_archive_objects SET settled_at=? WHERE user_id=? AND archive_id=? AND part_number=? AND pending_token=? AND settled_at IS NULL').bind(sourceReceipt.createdAt,owner,original.id,descriptor.part,token).run();
   const actual=await targetStorage.get(namespace,descriptor,services.signal);
   if(!actual||await contentHash(actual)!==descriptor.sha256)throw new Error('Target backup chunk verification failed.');
   await db.prepare('UPDATE backup_archive_objects SET verified_at=? WHERE user_id=? AND archive_id=? AND part_number=? AND pending_token=? AND settled_at IS NOT NULL').bind(sourceReceipt.createdAt,owner,original.id,descriptor.part,token).run();
  }
  await db.prepare("UPDATE backup_archives SET status='ready' WHERE user_id=? AND id=? AND status='preparing'").bind(owner,original.id).run();
  const checked=await readReadyFileBackup(target,owner,original.id,{...services.source,bucket:services.targetBucket},services.signal);
  if(!checked)throw new Error('Target native archive verification failed.');
  await checked.stream.cancel();
  if(checked.indexHash!==verified.indexHash)throw new Error('Target native archive verification failed.');
  mappings.push({archiveId:original.id,sourceNamespace:original.namespace,targetNamespace:namespace,indexSha256:verified.indexHash});
 }
 const targetUsage=await readBackupQuotaUsage(target,owner);
 if(targetUsage.count!==sourceUsage.count||targetUsage.bytes!==sourceUsage.bytes+additionalBytes)throw new Error('Recovery backup physical quota continuity differs.');
 return {mappings,retainedInert:snapshot.tables.backup_archives.length-mappings.length,sourceContinuitySha256:snapshot.sha256};
}
