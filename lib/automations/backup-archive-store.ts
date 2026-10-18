import {z} from 'zod';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import type {BackupManifest} from '../workspace-backups.ts';
import {BACKUP_LIMITS,BackupCapacityError} from '../workspace-backups.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle,type WorkspaceBundle} from '../workspace-export.ts';
import {attachmentRecordSchema} from '../evidence-module.ts';
import {inspectAttachmentManifest} from '../attachment-manifest.ts';
import {writeAttachmentArchive,attachmentArchivePath} from '../attachment-archive-export.ts';
import {inspectAttachmentArchive} from '../attachment-archive-import.ts';
import {createR2BlobStore,readReadyAttachment,type AttachmentBucket} from '../attachments.ts';
import {resolveAttachmentNamespace} from '../attachment-namespace-access.ts';
import {isBlobFenced} from '../attachment-upload-fences.ts';
import {attachmentPriorGenerationSql} from '../attachment-generation.ts';
import {validateAttachmentContent} from '../attachment-policy.ts';
import {createBackupArchiveStorage,backupArchiveChunks,backupArchiveKey,BACKUP_ARCHIVE_CHUNK_BYTES,type BackupArchiveBucket,type BackupArchiveChunk} from '../backup-archive-storage.ts';
import {backupQuotaGuard,readBackupQuotaUsage} from '../backup-archive-quota.ts';
import {scheduledBackupClaimGuard} from './backup-job-store.ts';
import type {ScheduledBackupClaim} from './contracts.ts';
import type {ProspectiveRecoverabilityResult} from '../recoverability-snapshot.ts';
import {recoverabilityAssertions,RecoverabilityCapacityError} from '../recoverability-admission.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().safe();
export const backupArchiveIndexSchema=z.object({format:z.literal('workspace-archive-chunks'),version:z.literal(1),archiveId:z.string().min(1).max(128),metadataSha256:digest,manifestSha256:digest,zipBytes:positive.max(BACKUP_LIMITS.ownerBytes),files:z.number().int().min(0).max(500),fileBytes:z.number().int().min(0).max(BACKUP_LIMITS.ownerBytes),chunks:z.array(z.object({part:z.number().int().min(0).max(4),bytes:positive.max(BACKUP_ARCHIVE_CHUNK_BYTES),sha256:digest}).strict()).min(1).max(5)}).strict().superRefine((value,ctx)=>{if(value.chunks.some((chunk,index)=>chunk.part!==index||index<value.chunks.length-1&&chunk.bytes!==BACKUP_ARCHIVE_CHUNK_BYTES)||value.chunks.reduce((n,row)=>n+row.bytes,0)!==value.zipBytes)ctx.addIssue({code:'custom',message:'Archive chunk layout differs.'});});
export type BackupArchiveIndex=z.infer<typeof backupArchiveIndexSchema>;
export interface FileBackupServices {bucket:BackupArchiveBucket;attachmentBucket:AttachmentBucket}
interface ArchiveRow {id:string;namespace:string;intent_id:string;source_revision:number;source_sha256:string;metadata_content:string|null;metadata_bytes:number;execution_epoch:number;status:string;created_at:string;updated_at:string;zip_bytes:number;files:number;file_bytes:number;chunk_count:number;index_json:string|null;index_sha256:string|null}
interface ChunkRow {part_number:number;storage_key:string;bytes:number;sha256:string|null;verified_at:string|null;purged_at:string|null;pending_token:string|null;settled_at:string|null}
export interface PreparedFileBackup {index:BackupArchiveIndex;indexHash:string;sourceProofs:Array<{id:string;storageKey:string;bytes:number;sha256:string}>}
export class PendingBackupArchiveWriteError extends Error {}
function stopped(signal?:AbortSignal){if(signal?.aborted)throw new Error('Backup archive was cancelled before its next storage operation.');}
async function archive(db:SqlDatabase,owner:string,id:string):Promise<ArchiveRow|null>{return db.prepare('SELECT * FROM backup_archives WHERE user_id=? AND id=?').bind(owner,id).first<ArchiveRow>();}
async function chunks(db:SqlDatabase,owner:string,id:string):Promise<ChunkRow[]>{const rows=(await db.prepare('SELECT part_number,storage_key,bytes,sha256,verified_at,purged_at,pending_token,settled_at FROM backup_archive_objects WHERE user_id=? AND archive_id=? ORDER BY part_number LIMIT 6').bind(owner,id).all<ChunkRow>()).results;if(rows.length>5)throw new Error('Archive chunk row count exceeds its bound.');return rows;}
function metadata(row:ArchiveRow):{manifest:BackupManifest;content:string;bundle:WorkspaceBundle}{
 if(!row.metadata_content||new TextEncoder().encode(row.metadata_content).length!==row.metadata_bytes||row.metadata_bytes>BACKUP_LIMITS.d1BundleBytes||!['preparing','ready'].includes(row.status))throw new Error('Archive metadata is unavailable.');
 const bundle=parseWorkspaceBundle(JSON.parse(row.metadata_content));if(bundle.source.workspaceRevision!==row.source_revision)throw new Error('Archive source revision differs.');
 return {content:row.metadata_content,bundle,manifest:{id:row.id,ownerScope:'',sourceRevision:row.source_revision,reason:'scheduled',createdAt:row.created_at,formatVersion:1,bytes:row.metadata_bytes,sha256:row.source_sha256,storageKind:'d1',storageKey:row.id,status:'ready',expiresAt:null,completeModules:['planning',...Object.keys(bundle.modules).sort()],missingAttachments:bundle.attachments.map(value=>value.id)}};
}
/** Reuse the ORIGINAL frozen serialization on retries. A changed source never silently replaces it. */
export async function readPreparingArchiveMetadata(db:SqlDatabase,claim:ScheduledBackupClaim):Promise<{manifest:BackupManifest;content:string}|null>{
 const row=await archive(db,claim.ownerId,claim.backupId);if(!row)return null;
 if(row.intent_id!==claim.intentId||row.execution_epoch!==claim.executionEpoch)throw new Error('Archive belongs to another admitted occurrence.');
 const value=metadata(row);if(await contentHash(value.content)!==row.source_sha256)throw new Error('Archive metadata digest differs.');
 const current=await exportWorkspaceBundle(db,claim.ownerId,{now:()=>row.created_at});
 if(JSON.stringify(current)!==value.content)throw new Error('Archive source changed; retain the original preparing recovery objects.');
 return {manifest:{...value.manifest,ownerScope:claim.ownerId},content:value.content};
}
async function layout(bundle:WorkspaceBundle){
 const inspection=inspectAttachmentManifest(bundle.modules);if(inspection.unresolvedLegacy)throw new Error('A file backup requires resolved typed attachment metadata.');
 const attachments=[];for(const entry of inspection.entries)attachments.push({...entry,archivePath:await attachmentArchivePath(entry.id),availability:'included' as const});
 const complete={...bundle,attachments,completeness:'complete' as const},manifestBytes=new TextEncoder().encode(JSON.stringify(complete));
 const fileBytes=inspection.entries.reduce((n,entry)=>n+entry.bytes,0),zipBytes=22+manifestBytes.length+76+2*new TextEncoder().encode('manifest.json').length+inspection.entries.reduce((n,entry)=>n+entry.bytes+76+2*new TextEncoder().encode(attachments.find(row=>row.id===entry.id)!.archivePath).length,0);
 if(zipBytes>BACKUP_LIMITS.ownerBytes)throw new BackupCapacityError('The complete file archive exceeds the owner backup byte bound.');
 return {zipBytes,fileBytes,files:inspection.entries.length,manifestSha256:await contentHash(manifestBytes)};
}
async function guardedBatch(db:SqlDatabase,claim:ScheduledBackupClaim,now:string,build:(gate:string,binds:(string|number|null)[],assert:(sql:string,bindings:(string|number|null)[])=>SqlStatement)=>SqlStatement[]):Promise<boolean>{
 const authority=await scheduledBackupClaimGuard(db,claim,now);if(!authority)return false;
 const id='file-backup-'+crypto.randomUUID(),token=crypto.randomUUID(),binds=[claim.ownerId,id,token],gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)';
 const assert=(sql:string,values:(string|number|null)[])=>db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+sql+' THEN 1 ELSE 0 END WHERE '+gate).bind(claim.ownerId,id,...values,...binds);
 const statements=[db.prepare('WITH authority AS MATERIALIZED(SELECT 1 WHERE '+authority.sql+') INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 WHERE EXISTS(SELECT 1 FROM authority)').bind(...authority.bindings,...binds),...build(gate,binds,assert),db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(claim.ownerId,id),db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...binds)];
 return (await db.batch(statements))[0]?.meta.changes===1;
}
async function reserve(db:SqlDatabase,claim:ScheduledBackupClaim,prepared:{manifest:BackupManifest;content:string},shape:Awaited<ReturnType<typeof layout>>,boundary:ProspectiveRecoverabilityResult,now:string){
 const existing=await archive(db,claim.ownerId,claim.backupId);if(existing){if(existing.source_sha256!==prepared.manifest.sha256||existing.metadata_content!==prepared.content||existing.zip_bytes!==shape.zipBytes||existing.execution_epoch!==claim.executionEpoch||existing.intent_id!==claim.intentId||existing.status!=='preparing')throw new Error('An immutable archive reservation already differs.');return existing;}
 if(!boundary.measurement.allowed)throw new RecoverabilityCapacityError();
 const namespace=crypto.randomUUID(),count=Math.ceil(shape.zipBytes/BACKUP_ARCHIVE_CHUNK_BYTES),quota=backupQuotaGuard(claim.ownerId,prepared.manifest.bytes+shape.zipBytes,1);
 const usage=await readBackupQuotaUsage(db,claim.ownerId);if(usage.count+1>BACKUP_LIMITS.snapshots||usage.bytes+prepared.manifest.bytes+shape.zipBytes>BACKUP_LIMITS.ownerBytes)throw new BackupCapacityError('Retained backup storage capacity is exhausted.');
 const saved=await guardedBatch(db,claim,now,(gate,binds,assert)=>{
  const statements:SqlStatement[]=[...recoverabilityAssertions(db,claim.ownerId,String(binds[1]),boundary,gate,binds),assert(quota.sql,quota.bindings),assert('NOT EXISTS(SELECT 1 FROM backup_archives WHERE user_id=? AND id=?) AND NOT EXISTS(SELECT 1 FROM workspace_backups WHERE user_id=? AND id=?)',[claim.ownerId,claim.backupId,claim.ownerId,claim.backupId])];
  statements.push(db.prepare("INSERT INTO backup_archives(user_id,id,namespace,intent_id,source_revision,source_sha256,metadata_content,metadata_bytes,execution_epoch,status,created_at,updated_at,zip_bytes,files,file_bytes,chunk_count,index_json,index_sha256) SELECT ?,?,?,?,?,?,?,?,?, 'preparing',?,?,?,?,?,?,NULL,NULL WHERE "+gate).bind(claim.ownerId,claim.backupId,namespace,claim.intentId,prepared.manifest.sourceRevision,prepared.manifest.sha256,prepared.content,prepared.manifest.bytes,claim.executionEpoch,now,now,shape.zipBytes,shape.files,shape.fileBytes,count,...binds));
  for(let part=0;part<count;part++)statements.push(db.prepare('INSERT INTO backup_archive_objects(user_id,archive_id,part_number,storage_key,bytes,sha256,created_at,verified_at,purged_at,pending_token,settled_at) SELECT ?,?,?,?,?,NULL,?,NULL,NULL,NULL,NULL WHERE '+gate).bind(claim.ownerId,claim.backupId,part,backupArchiveKey(namespace,part),Math.min(BACKUP_ARCHIVE_CHUNK_BYTES,shape.zipBytes-part*BACKUP_ARCHIVE_CHUNK_BYTES),now,...binds));
  return statements;
 });if(!saved)throw new Error('Archive reservation authority changed.');
 const row=await archive(db,claim.ownerId,claim.backupId);if(!row)throw new Error('Archive reservation was not confirmed.');return row;
}
function sourceProofs(bundle:WorkspaceBundle){return (bundle.modules.attachments?.records??[]).flatMap(raw=>{const record=attachmentRecordSchema.parse((raw as {value:unknown}).value);return record.status==='ready'?[record]:[];});}
function objectStream(storage:ReturnType<typeof createBackupArchiveStorage>,namespace:string,index:BackupArchiveIndex,signal?:AbortSignal):ReadableStream<Uint8Array>{
 let part=0;return new ReadableStream({async pull(controller){try{stopped(signal);if(part===index.chunks.length){controller.close();return;}const bytes=await storage.get(namespace,index.chunks[part++],signal);if(!bytes)throw new Error('A reserved archive object is missing.');controller.enqueue(bytes);}catch(error){controller.error(error);}}});
}
async function inspectStored(db:SqlDatabase,owner:string,row:ArchiveRow,index:BackupArchiveIndex,services:FileBackupServices,signal?:AbortSignal){
 const verifyLedger=async()=>{const retained=await chunks(db,owner,row.id);if(retained.length!==index.chunks.length||retained.some((chunk,part)=>chunk.part_number!==part||chunk.storage_key!==backupArchiveKey(row.namespace,part)||chunk.bytes!==index.chunks[part].bytes||chunk.sha256!==index.chunks[part].sha256||chunk.verified_at===null||chunk.purged_at!==null))throw new Error('Archive physical ledger differs.');};await verifyLedger();
 const expected=metadata(row),records=new Map(sourceProofs(expected.bundle).map(record=>[record.id,record]));
 if(await contentHash(expected.content)!==index.metadataSha256||index.archiveId!==row.id||index.zipBytes!==row.zip_bytes||index.files!==row.files||index.fileBytes!==row.file_bytes)throw new Error('Archive index source metadata differs.');
 const actual=await inspectAttachmentArchive(objectStream(createBackupArchiveStorage(services.bucket),row.namespace,index,signal),async(id,bytes)=>{const record=records.get(id);if(!record)throw new Error('Archive introduced an unknown attachment.');validateAttachmentContent(bytes,record.mimeType,record.expectedBytes);});
 const normalized={...expected.bundle,completeness:'metadata-only',attachments:expected.bundle.attachments.map(entry=>({...entry,archivePath:null,availability:'excluded'}))};
 if(canonical(actual.metadataBundle)!==canonical(normalized)||await contentHash(new TextEncoder().encode(JSON.stringify(actual.manifest)))!==index.manifestSha256)throw new Error('Archive frozen manifest differs.');
 await verifyLedger();
}
export async function prepareScheduledFileArchive(db:SqlDatabase,claim:ScheduledBackupClaim,prepared:{manifest:BackupManifest;content:string},boundary:ProspectiveRecoverabilityResult,services:FileBackupServices,options:{now:()=>string;signal?:AbortSignal}):Promise<PreparedFileBackup>{
 stopped(options.signal);const bundle=parseWorkspaceBundle(JSON.parse(prepared.content)),shape=await layout(bundle),row=await reserve(db,claim,prepared,shape,boundary,options.now()),records=sourceProofs(bundle),byId=new Map(records.map(record=>[record.id,record])),storage=createBackupArchiveStorage(services.bucket),blobStore=createR2BlobStore(services.attachmentBucket);
 const prior=await chunks(db,claim.ownerId,claim.backupId);if(prior.length!==row.chunk_count||prior.some((chunk,part)=>chunk.part_number!==part||chunk.storage_key!==backupArchiveKey(row.namespace,part)||chunk.bytes!==Math.min(BACKUP_ARCHIVE_CHUNK_BYTES,row.zip_bytes-part*BACKUP_ARCHIVE_CHUNK_BYTES)||chunk.purged_at!==null))throw new Error('Archive reservation layout differs.');
 // A crash after every object was written can reconcile without re-reading live files.
 if(row.index_json&&row.index_sha256){const index=backupArchiveIndexSchema.parse(JSON.parse(row.index_json));if(await contentHash(canonical(index))!==row.index_sha256)throw new Error('Archive index hash differs.');await inspectStored(db,claim.ownerId,row,index,services,options.signal);return {index,indexHash:row.index_sha256,sourceProofs:records.map(record=>({id:record.id,storageKey:record.storageKey,bytes:record.expectedBytes,sha256:record.sha256!}))};}
 const stream=writeAttachmentArchive(bundle,records,async id=>{
  stopped(options.signal);const record=byId.get(id);if(!record||await isBlobFenced(db,claim.ownerId,{attachmentId:id,storageKey:record.storageKey}))throw new Error('Frozen source attachment is fenced.');
  const namespace=await resolveAttachmentNamespace(db,claim.ownerId,record);if(!namespace)throw new Error('Frozen source attachment namespace is unavailable.');
  const proof=await db.prepare('SELECT bytes,sha256 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND attachment_id=? AND namespace=? AND verified_at IS NOT NULL AND purged_at IS NULL').bind(claim.ownerId,record.storageKey,id,namespace).first<{bytes:number;sha256:string|null}>();if(!proof||proof.bytes!==record.expectedBytes||proof.sha256!==record.sha256)throw new Error('Frozen attachment physical proof differs.');
  const received=await readReadyAttachment(claim.ownerId,record,blobStore,{ownerNamespace:namespace,now:options.now()});stopped(options.signal);return received.bytes;
 });
 const descriptors:BackupArchiveChunk[]=[];let part=0;
 for await(const bytes of backupArchiveChunks(stream,row.zip_bytes)){
  stopped(options.signal);const descriptor={part,bytes:bytes.length,sha256:await contentHash(bytes)},old=prior[part];if(old.sha256!==null&&old.sha256!==descriptor.sha256)throw new Error('A reserved immutable archive chunk differs.');
  if(old.sha256!==null){const existing=await storage.get(row.namespace,descriptor,options.signal);if(existing){if(!await guardedBatch(db,claim,options.now(),(gate,binds)=>[db.prepare('UPDATE backup_archive_objects SET verified_at=COALESCE(verified_at,?) WHERE user_id=? AND archive_id=? AND part_number=? AND sha256=? AND purged_at IS NULL AND '+gate).bind(options.now(),claim.ownerId,claim.backupId,part,descriptor.sha256,...binds)]))throw new Error('Archive reconciliation authority changed.');descriptors.push(descriptor);part++;continue;}if(old.pending_token!==null&&old.settled_at===null)throw new PendingBackupArchiveWriteError('An archive PUT outcome is unconfirmed; no duplicate PUT was started.');throw new Error('An already settled archive chunk is missing.');}
  const pending=crypto.randomUUID();if(!await guardedBatch(db,claim,options.now(),(gate,binds,assert)=>[assert("EXISTS(SELECT 1 FROM backup_archives WHERE user_id=? AND id=? AND status='preparing' AND execution_epoch=?)",[claim.ownerId,claim.backupId,claim.executionEpoch]),db.prepare('UPDATE backup_archive_objects SET sha256=?,pending_token=? WHERE user_id=? AND archive_id=? AND part_number=? AND sha256 IS NULL AND pending_token IS NULL AND purged_at IS NULL AND '+gate).bind(descriptor.sha256,pending,claim.ownerId,claim.backupId,part,...binds),assert('EXISTS(SELECT 1 FROM backup_archive_objects WHERE user_id=? AND archive_id=? AND part_number=? AND sha256=? AND pending_token=?)',[claim.ownerId,claim.backupId,part,descriptor.sha256,pending])]))throw new Error('Archive write-ahead admission changed.');
  stopped(options.signal);await storage.put(row.namespace,descriptor,bytes);
  // Only this awaited, definitively settled invocation can clear its pending write.
  await db.prepare('UPDATE backup_archive_objects SET settled_at=? WHERE user_id=? AND archive_id=? AND part_number=? AND pending_token=? AND settled_at IS NULL').bind(options.now(),claim.ownerId,claim.backupId,part,pending).run();
  if(!await storage.get(row.namespace,descriptor,options.signal))throw new Error('Archive object is missing after its PUT.');
  if(!await guardedBatch(db,claim,options.now(),(gate,binds)=>[db.prepare('UPDATE backup_archive_objects SET verified_at=? WHERE user_id=? AND archive_id=? AND part_number=? AND sha256=? AND pending_token=? AND settled_at IS NOT NULL AND purged_at IS NULL AND '+gate).bind(options.now(),claim.ownerId,claim.backupId,part,descriptor.sha256,pending,...binds)]))throw new Error('Archive object verification authority changed.');
  descriptors.push(descriptor);part++;
 }
 const index=backupArchiveIndexSchema.parse({format:'workspace-archive-chunks',version:1,archiveId:claim.backupId,metadataSha256:prepared.manifest.sha256,manifestSha256:shape.manifestSha256,zipBytes:shape.zipBytes,files:shape.files,fileBytes:shape.fileBytes,chunks:descriptors}),indexHash=await contentHash(canonical(index));
 await inspectStored(db,claim.ownerId,row,index,services,options.signal);stopped(options.signal);
 if(!await guardedBatch(db,claim,options.now(),(gate,binds,assert)=>[assert('NOT EXISTS(SELECT 1 FROM backup_archives WHERE user_id=? AND id=? AND index_sha256 IS NOT NULL AND index_sha256<>?)',[claim.ownerId,claim.backupId,indexHash]),db.prepare("UPDATE backup_archives SET index_json=?,index_sha256=?,updated_at=? WHERE user_id=? AND id=? AND status='preparing' AND "+gate).bind(canonical(index),indexHash,options.now(),claim.ownerId,claim.backupId,...binds)]))throw new Error('Archive index publication authority changed.');
 return {index,indexHash,sourceProofs:records.map(record=>({id:record.id,storageKey:record.storageKey,bytes:record.expectedBytes,sha256:record.sha256!}))};
}
/** The central terminal batch supplies its existing claim; readiness cannot be published separately. */
export function fileArchiveReadyStatements(db:SqlDatabase,owner:string,id:string,prepared:PreparedFileBackup,now:string,gate:string,binds:(string|number|null)[],mutationId:string):SqlStatement[]{
 const assert=(sql:string,values:(string|number|null)[])=>db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+sql+' THEN 1 ELSE 0 END WHERE '+gate).bind(owner,mutationId,...values,...binds);
 const generation=attachmentPriorGenerationSql({owner:'o.user_id',attachmentId:'o.attachment_id',storageKey:'o.storage_key',bytes:'o.bytes',sha256:'o.sha256'});
 const quota=backupQuotaGuard(owner);
 return [assert(quota.sql,quota.bindings),assert("EXISTS(SELECT 1 FROM backup_archives WHERE user_id=? AND id=? AND status='preparing' AND index_sha256=? AND index_json=?)",[owner,id,prepared.indexHash,canonical(prepared.index)]),
 assert('(SELECT COUNT(*) FROM backup_archive_objects WHERE user_id=? AND archive_id=?)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM backup_archive_objects o WHERE o.user_id=? AND o.archive_id=? AND o.part_number=json_extract(j.value,\'$.part\') AND o.bytes=json_extract(j.value,\'$.bytes\') AND o.sha256=json_extract(j.value,\'$.sha256\') AND o.verified_at IS NOT NULL AND o.purged_at IS NULL))',[owner,id,prepared.index.chunks.length,canonical(prepared.index.chunks),owner,id]),
 assert("NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.attachment_id=json_extract(j.value,'$.id') AND o.storage_key=json_extract(j.value,'$.storageKey') AND o.bytes=json_extract(j.value,'$.bytes') AND o.sha256=json_extract(j.value,'$.sha256') AND o.verified_at IS NOT NULL AND o.purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences f WHERE f.user_id=o.user_id AND f.storage_key=o.storage_key) AND "+generation+'))',[canonical(prepared.sourceProofs),owner]),
 db.prepare("UPDATE backup_archives SET status='ready',updated_at=? WHERE user_id=? AND id=? AND status='preparing' AND index_sha256=? AND "+gate).bind(now,owner,id,prepared.indexHash,...binds)];
}
/** Owner read of a complete retained file recovery point. No imported storage key is honored. */
export async function readReadyFileBackup(db:SqlDatabase,owner:string,id:string,services:FileBackupServices,signal?:AbortSignal):Promise<{index:BackupArchiveIndex;indexHash:string;stream:ReadableStream<Uint8Array>}|null>{
 const row=await archive(db,owner,id);if(!row||row.status!=='ready')return null;
 const logical=await db.prepare("SELECT sha256,content,status FROM workspace_backups WHERE user_id=? AND id=?").bind(owner,id).first<{sha256:string;content:string;status:string}>();if(!logical||logical.status!=='ready'||logical.sha256!==row.source_sha256||logical.content!==row.metadata_content||!row.index_json||!row.index_sha256)return null;
 const index=backupArchiveIndexSchema.parse(JSON.parse(row.index_json));if(await contentHash(canonical(index))!==row.index_sha256)throw new Error('Retained archive index digest differs.');
 await inspectStored(db,owner,row,index,services,signal);
 return {index,indexHash:row.index_sha256,stream:objectStream(createBackupArchiveStorage(services.bucket),row.namespace,index,signal)};
}
/** Explicit logical removal only; physical objects/pending tokens remain charged, never auto-deleted. */
export function retireFileBackupStatements(db:SqlDatabase,owner:string,id:string,now:string,gate:string,binds:(string|number|null)[]):SqlStatement[]{
 return [db.prepare("UPDATE backup_archives SET status='retired',metadata_content=NULL,metadata_bytes=0,updated_at=? WHERE user_id=? AND id=? AND status='ready' AND "+gate).bind(now,owner,id,...binds)];
}
