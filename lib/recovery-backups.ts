import type {SqlDatabase} from './workspace-store.ts';
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
 await bindFrozenPrivateContinuity(source,sourceReceipt,continuity,continuity.sha256);
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
 const tables=continuity.tables as unknown as Record<string,Row[]>;
 if(!Array.isArray(tables.workspace_backups)||!Array.isArray(tables.backup_archive_cleanup_claims))
  throw new Error('Complete logical backup and permanent cleanup continuity is required.');
 for(const logical of tables.workspace_backups)await insert('workspace_backups',logical);
 for(const claim of tables.backup_archive_cleanup_claims)await insert('backup_archive_cleanup_claims',claim);
 const mappings:{archiveId:string;sourceNamespace:string;targetNamespace:string;indexSha256:string}[]=[];
 for(const original of continuity.tables.backup_archives){
  const objects=continuity.tables.backup_archive_objects.filter(object=>object.archive_id===original.id);
  if(objects.some(object=>object.pending_token!==null&&object.settled_at===null))throw new Error('Unsettled source backup PUT cannot be copied.');
  if(original.status!=='ready'){
   // Inert history/charge ledger stays exact. Retired/preparing/failed entries
   // never get promoted to downloadable ready archives or new object PUTs.
   await insert('backup_archives',original);
   for(const object of objects)await insert('backup_archive_objects',object);
   continue;
  }
  for(const object of objects){
   if(await source.prepare('SELECT 1 FROM backup_archive_cleanup_claims WHERE storage_key=?').bind(object.storage_key).first())
    throw new Error('Fenced source backup object cannot be advertised as ready.');
  }
  const verified=await readReadyFileBackup(source,owner,original.id,services.source,services.signal);
  if(!verified||verified.indexHash!==original.index_sha256)throw new Error('Ready source archive is unavailable or differs.');
  await verified.stream.cancel();
  const namespace=crypto.randomUUID(),row={...original,namespace,status:'preparing'};
  await insert('backup_archives',row);
  for(const descriptor of verified.index.chunks){
   const bytes=await sourceStorage.get(original.namespace,descriptor,services.signal);
   if(!bytes)throw new Error('Frozen source backup chunk is unavailable.');
   const token=crypto.randomUUID(),storageKey=backupArchiveKey(namespace,descriptor.part);
   const object={archive_id:original.id,part_number:descriptor.part,storage_key:storageKey,bytes:descriptor.bytes,sha256:descriptor.sha256,created_at:sourceReceipt.createdAt,verified_at:null,purged_at:null,pending_token:token,settled_at:null};
   await insert('backup_archive_objects',object);
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
  if(!checked||checked.indexHash!==verified.indexHash)throw new Error('Target native archive verification failed.');
  await checked.stream.cancel();
  mappings.push({archiveId:original.id,sourceNamespace:original.namespace,targetNamespace:namespace,indexSha256:verified.indexHash});
 }
 return {mappings,retainedInert:continuity.tables.backup_archives.length-mappings.length,sourceContinuitySha256:continuity.sha256};
}
