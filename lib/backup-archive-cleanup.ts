import {requirePrivateCapacity,privateRowGrowth,type PrivateGrowth} from '../private-capacity.ts';
import {z} from 'zod';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceIdSchema as id,evidenceDateSchema as stamp} from '../evidence-validation.ts';
import {backupArchiveIndexSchema,readReadyFileBackup,type FileBackupServices,type BackupArchiveIndex} from './backup-archive-store.ts';
import {fileBackupRemovalControlSchema} from './backup-archive-removal.ts';
import {backupArchiveKey,createBackupArchiveStorage,type BackupArchiveBucket} from '../backup-archive-storage.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().safe();
export interface BackupArchiveCleanupBucket extends BackupArchiveBucket {delete(key:string):Promise<void>}
const archiveSchema=z.object({id,namespace:z.string().uuid(),source_sha256:digest,execution_epoch:z.number().int().nonnegative().safe(),status:z.literal('retired'),metadata_content:z.null(),metadata_bytes:z.literal(0),updated_at:stamp,index_json:z.string().max(10000),index_sha256:digest}).strict();
const objectSchema=z.object({part_number:z.number().int().min(0).max(4),storage_key:z.string().max(200),bytes:positive.max(4*1024*1024),sha256:digest,verified_at:stamp,purged_at:stamp.nullable(),pending_token:z.string().uuid().nullable(),settled_at:stamp.nullable()}).strict();
type ObjectRow=z.infer<typeof objectSchema>;
interface Retired {archive:z.infer<typeof archiveSchema>;objects:ObjectRow[];index:BackupArchiveIndex}
async function retired(db:SqlDatabase,owner:string,archiveId:string,expectedHash:string):Promise<Retired>{
 const raw=await db.prepare('SELECT id,namespace,source_sha256,execution_epoch,status,metadata_content,metadata_bytes,updated_at,index_json,index_sha256 FROM backup_archives WHERE user_id=? AND id=?').bind(owner,archiveId).first();
 const archive=archiveSchema.parse(raw),index=backupArchiveIndexSchema.parse(JSON.parse(archive.index_json));
 if(archive.id!==archiveId||archive.index_sha256!==expectedHash||await contentHash(canonical(index))!==expectedHash||index.archiveId!==archiveId||index.metadataSha256!==archive.source_sha256)throw new Error('Retired archive identity is unavailable.');
 if(await db.prepare('SELECT 1 FROM workspace_backups WHERE user_id=? AND id=?').bind(owner,archiveId).first())throw new Error('A retained logical backup cannot be physically cleaned up.');
 const rows=(await db.prepare('SELECT part_number,storage_key,bytes,sha256,verified_at,purged_at,pending_token,settled_at FROM backup_archive_objects WHERE user_id=? AND archive_id=? ORDER BY part_number LIMIT 6').bind(owner,archiveId).all()).results,objects=z.array(objectSchema).min(1).max(5).parse(rows);
 if(objects.length!==index.chunks.length||objects.some((object,part)=>object.part_number!==part||object.storage_key!==backupArchiveKey(archive.namespace,part)||object.bytes!==index.chunks[part].bytes||object.sha256!==index.chunks[part].sha256))throw new Error('Retired archive physical bookkeeping differs.');
 return {archive,objects,index};
}
function current(owner:string,value:Retired,object:ObjectRow):{sql:string;bindings:(string|number|null)[]}{
 return {sql:"EXISTS(SELECT 1 FROM backup_archives a JOIN backup_archive_objects o ON o.user_id=a.user_id AND o.archive_id=a.id WHERE a.user_id=? AND a.id=? AND a.namespace=? AND a.status='retired' AND a.metadata_content IS NULL AND a.metadata_bytes=0 AND a.execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=a.user_id),0) AND a.index_sha256=? AND a.index_json=? AND o.part_number=? AND o.storage_key=? AND o.bytes=? AND o.sha256=? AND o.verified_at IS NOT NULL AND o.purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM workspace_backups b WHERE b.user_id=a.user_id AND b.id=a.id) AND NOT EXISTS(SELECT 1 FROM backup_archive_objects pending WHERE pending.user_id=a.user_id AND pending.archive_id=a.id AND pending.pending_token IS NOT NULL AND pending.settled_at IS NULL)) AND (SELECT COUNT(*) FROM backup_archive_objects WHERE user_id=? AND archive_id=?)=? AND NOT EXISTS(SELECT part_number,storage_key,bytes,sha256,verified_at,purged_at,pending_token,settled_at FROM backup_archive_objects WHERE user_id=? AND archive_id=? EXCEPT SELECT json_extract(value,'$.part_number'),json_extract(value,'$.storage_key'),json_extract(value,'$.bytes'),json_extract(value,'$.sha256'),json_extract(value,'$.verified_at'),json_extract(value,'$.purged_at'),json_extract(value,'$.pending_token'),json_extract(value,'$.settled_at') FROM json_each(?))",bindings:[owner,value.archive.id,value.archive.namespace,value.archive.index_sha256,value.archive.index_json,object.part_number,object.storage_key,object.bytes,object.sha256,owner,value.archive.id,value.objects.length,owner,value.archive.id,canonical(value.objects)]};
}
async function settle(db:SqlDatabase,owner:string,value:Retired,object:ObjectRow,token:string,now:string):Promise<void>{
 const capacity=await requirePrivateCapacity(db,owner,{growth:[await privateBackupUpdates(db,owner,'backup_archive_objects','archive_id=? AND part_number=?',[value.archive.id,object.part_number],{purged_at:now}),await privateBackupUpdates(db,owner,'backup_archive_cleanup_claims','storage_key=?',[object.storage_key],{purged_at:now})]});
 const proof=current(owner,value,object),mutation='archive-cleanup-settle-'+crypto.randomUUID(),guardToken=crypto.randomUUID(),binds=[owner,mutation,guardToken],gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)';
 const claim="EXISTS(SELECT 1 FROM backup_archive_cleanup_claims WHERE user_id=? AND storage_key=? AND archive_id=? AND part_number=? AND token=?)",claimBinds=[owner,object.storage_key,value.archive.id,object.part_number,token];
 const statements:SqlStatement[]=[
 db.prepare('WITH proof AS MATERIALIZED(SELECT 1 WHERE '+proof.sql+' AND '+claim+' AND '+capacity.sql+') INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 WHERE EXISTS(SELECT 1 FROM proof)').bind(...proof.bindings,...claimBinds,...capacity.bindings,...binds),
 db.prepare('UPDATE backup_archive_objects SET purged_at=COALESCE(purged_at,?) WHERE user_id=? AND archive_id=? AND part_number=? AND storage_key=? AND '+gate).bind(now,owner,value.archive.id,object.part_number,object.storage_key,...binds),
 db.prepare('UPDATE backup_archive_cleanup_claims SET purged_at=COALESCE(purged_at,?) WHERE user_id=? AND storage_key=? AND token=? AND '+gate).bind(now,owner,object.storage_key,token,...binds),
 db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...binds)
 ];await db.batch(statements);
}
export interface FileBackupCleanupResult {status:'completed'|'partial'|'blocked'|'uncertain';reason?:'pending_upload'|'storage_unavailable'|'cleanup_unconfirmed'|'authorization_stale';purgedParts:number;retainedBytes:number;physicalDeletion:boolean}
/** Explicit authenticated-owner operation only. No automatic retention, timer expiry,
 * arbitrary key, new namespace reuse, or clearing of unknown PUT/DELETE outcomes. */
export async function cleanupRetiredFileBackup(db:SqlDatabase,owner:string,input:{id:string;indexHash:string},options:{now:()=>string;bucket?:BackupArchiveCleanupBucket;signal?:AbortSignal;deleteDeadlineMs?:number}):Promise<FileBackupCleanupResult>{
 const command=z.object({id,indexHash:digest}).strict().parse(input),deleteDeadlineMs=z.number().int().min(1).max(15000).parse(options.deleteDeadlineMs??15000);if(!owner||owner.trim()!==owner||owner.length>256||/[\u0000-\u001f\u007f]/u.test(owner))throw new Error('An authenticated owner is required.');
 let value=await retired(db,owner,command.id,command.indexHash),purgedParts=0;
 const result=(status:FileBackupCleanupResult['status'],reason?:FileBackupCleanupResult['reason']):FileBackupCleanupResult=>({status,...(reason?{reason}:{}),purgedParts,retainedBytes:value.objects.filter(row=>row.purged_at===null).reduce((n,row)=>n+row.bytes,0),physicalDeletion:purgedParts>0});
 const epoch=await db.prepare('SELECT COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0) epoch').bind(owner).first<{epoch:number}>();if(epoch?.epoch!==value.archive.execution_epoch)return result('blocked','authorization_stale');
 if(value.objects.some(row=>row.pending_token!==null&&row.settled_at===null))return result('blocked','pending_upload');
 if(!options.bucket)return result('blocked','storage_unavailable');
 const storage=createBackupArchiveStorage(options.bucket),budget=new AbortController(),timer=setTimeout(()=>budget.abort(),15000),signal=options.signal?AbortSignal.any([options.signal,budget.signal]):budget.signal;
 try{for(const initial of value.objects){
  if(initial.purged_at!==null)continue;if(signal.aborted)return result('partial');
  try{
   const now=stamp.parse(options.now()),object=value.objects[initial.part_number],proof=current(owner,value,object);
   // Verify the exact old immutable object when present; corruption never authorizes deleting another body.
   const present=await storage.get(value.archive.namespace,value.index.chunks[object.part_number],signal);
   const existing=await db.prepare('SELECT archive_id,part_number,token FROM backup_archive_cleanup_claims WHERE user_id=? AND storage_key=?').bind(owner,object.storage_key).first<{archive_id:string;part_number:number;token:string}>();
   if(existing&&(existing.archive_id!==command.id||existing.part_number!==object.part_number||!z.string().uuid().safeParse(existing.token).success))throw new Error('Permanent cleanup identity differs.');
   if(existing&&present)return result('uncertain','cleanup_unconfirmed');
   const token=existing?.token??crypto.randomUUID(),capacity=await requirePrivateCapacity(db,owner,{growth:existing?[]:[privateRowGrowth('backup_archive_cleanup_claims',null,{storage_key:object.storage_key,archive_id:command.id,part_number:object.part_number,token,claimed_at:now,purged_at:null})]});
   await db.prepare('INSERT OR IGNORE INTO backup_archive_cleanup_claims(user_id,storage_key,archive_id,part_number,token,claimed_at,purged_at) SELECT ?,?,?,?,?,?,NULL WHERE '+proof.sql+' AND '+capacity.sql).bind(owner,object.storage_key,command.id,object.part_number,token,now,...proof.bindings,...capacity.bindings).run();
   const admitted=await db.prepare('SELECT 1 WHERE '+proof.sql+' AND EXISTS(SELECT 1 FROM backup_archive_cleanup_claims WHERE user_id=? AND storage_key=? AND archive_id=? AND part_number=? AND token=?)').bind(...proof.bindings,owner,object.storage_key,command.id,object.part_number,token).first();
   if(!admitted)throw new Error('Cleanup authority changed before deletion.');
   if(signal.aborted)return result('partial');
   // Await the actual DELETE; an exception is UNKNOWN and retains its permanent claim and charge.
   if(present){let deleteTimer:ReturnType<typeof setTimeout>|undefined,stop=()=>{};const deadline=new Promise<never>((_,reject)=>{stop=()=>reject(new Error('Cleanup DELETE outcome is unconfirmed.'));signal.addEventListener('abort',stop,{once:true});deleteTimer=setTimeout(stop,deleteDeadlineMs);});try{await Promise.race([options.bucket.delete(object.storage_key),deadline]);}finally{clearTimeout(deleteTimer);signal.removeEventListener('abort',stop);}}
   // Once DELETE settled, finish its safe bookkeeping even if the request was subsequently cancelled.
   if(await storage.get(value.archive.namespace,value.index.chunks[object.part_number]))throw new Error('Archive object still exists after deletion.');
   await settle(db,owner,value,object,token,stamp.parse(options.now()));
   value=await retired(db,owner,command.id,command.indexHash);if(value.objects[object.part_number].purged_at===null)throw new Error('Physical purge bookkeeping was not confirmed.');purgedParts++;
  }catch{
   try{value=await retired(db,owner,command.id,command.indexHash);}catch{return {status:'uncertain',reason:'cleanup_unconfirmed',purgedParts,retainedBytes:value.objects.filter(row=>row.purged_at===null).reduce((n,row)=>n+row.bytes,0),physicalDeletion:purgedParts>0};}
   return result('uncertain','cleanup_unconfirmed');
  }
 }
 return result('completed');}finally{clearTimeout(timer);}
}
export interface RetiredFileBackupSummary {id:string;indexHash:string;retiredAt:string;files:number;archiveBytes:number;chargedBytes:number;chargedParts:number;pendingUploadCount:number;pendingCleanupCount:number;cleanupAuthorized:boolean}
/** Sanitized keyset page. SQL aggregates object state; no keys/namespaces/owner IDs are returned. */
export async function listRetiredFileBackups(db:SqlDatabase,owner:string,options:{after?:string;limit?:number}={}):Promise<{items:RetiredFileBackupSummary[];nextAfter:string|null}>{
 const parsed=z.object({after:id.optional(),limit:z.number().int().min(1).max(50).optional()}).strict().parse(options);if(!owner||owner.trim()!==owner||owner.length>256||/[\u0000-\u001f\u007f]/u.test(owner))throw new Error('An authenticated owner is required.');
 const limit=parsed.limit??50,rows=(await db.prepare("SELECT a.id,a.index_sha256,a.updated_at,a.files,a.zip_bytes,(a.execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=a.user_id),0)) cleanup_authorized,(SELECT COALESCE(SUM(bytes),0) FROM backup_archive_objects o WHERE o.user_id=a.user_id AND o.archive_id=a.id AND o.purged_at IS NULL) charged_bytes,(SELECT COUNT(*) FROM backup_archive_objects o WHERE o.user_id=a.user_id AND o.archive_id=a.id AND o.purged_at IS NULL) charged_parts,(SELECT COUNT(*) FROM backup_archive_objects o WHERE o.user_id=a.user_id AND o.archive_id=a.id AND o.pending_token IS NOT NULL AND o.settled_at IS NULL) pending_uploads,(SELECT COUNT(*) FROM backup_archive_cleanup_claims c WHERE c.user_id=a.user_id AND c.archive_id=a.id AND c.purged_at IS NULL) pending_cleanups FROM backup_archives a WHERE a.user_id=? AND a.status='retired' AND a.id>? ORDER BY a.id LIMIT ?").bind(owner,parsed.after??'',limit+1).all<{id:string;index_sha256:string;updated_at:string;files:number;zip_bytes:number;charged_bytes:number;charged_parts:number;pending_uploads:number;pending_cleanups:number;cleanup_authorized:number}>()).results;
 const schema=z.object({id,indexHash:digest,retiredAt:stamp,files:z.number().int().min(0).max(500),archiveBytes:positive.max(20_000_000),chargedBytes:z.number().int().min(0).max(20_000_000),chargedParts:z.number().int().min(0).max(5),pendingUploadCount:z.number().int().min(0).max(5),pendingCleanupCount:z.number().int().min(0).max(5),cleanupAuthorized:z.boolean()}).strict();
 const items=rows.slice(0,limit).map(row=>schema.parse({id:row.id,indexHash:row.index_sha256,retiredAt:row.updated_at,files:row.files,archiveBytes:row.zip_bytes,chargedBytes:row.charged_bytes,chargedParts:row.charged_parts,pendingUploadCount:row.pending_uploads,pendingCleanupCount:row.pending_cleanups,cleanupAuthorized:row.cleanup_authorized===1}));
 return {items,nextAfter:rows.length>limit?items.at(-1)!.id:null};
}

const readySideSchema=fileBackupRemovalControlSchema.shape.selected;
const completeRetiredArchiveSchema=readySideSchema.shape.archive.extend({status:z.literal('retired'),metadata_content:z.null(),metadata_bytes:z.literal(0)}).strict();
const reauthorizationClaimSchema=z.object({storage_key:z.string().max(200),archive_id:id,part_number:z.number().int().min(0).max(4),token:z.string().uuid(),claimed_at:stamp,purged_at:stamp.nullable()}).strict();
const reauthorizationOldObjectSchema=readySideSchema.shape.objects.element.extend({purged_at:stamp.nullable()}).strict();
async function readyAuthorizationSide(db:SqlDatabase,owner:string,archiveId:string){
 const columns={logical:Object.keys(readySideSchema.shape.logical.shape),archive:Object.keys(readySideSchema.shape.archive.shape),objects:Object.keys(readySideSchema.shape.objects.element.shape)};
 return readySideSchema.parse({
 logical:await db.prepare('SELECT '+columns.logical.join(',')+' FROM workspace_backups WHERE user_id=? AND id=?').bind(owner,archiveId).first(),
 archive:await db.prepare('SELECT '+columns.archive.join(',')+' FROM backup_archives WHERE user_id=? AND id=?').bind(owner,archiveId).first(),
 objects:(await db.prepare('SELECT '+columns.objects.join(',')+' FROM backup_archive_objects WHERE user_id=? AND archive_id=? ORDER BY part_number LIMIT 6').bind(owner,archiveId).all()).results,
 });
}
export interface RetiredFileBackupAuthorization {status:'authorized';id:string;indexHash:string;executionEpoch:number}
/**
 * Fresh explicit authenticated owner consent only. Historical private continuity
 * remains inert until an independently verified strictly newer full file point
 * and exact old/new/claim rowsets authorize this single epoch stamp. No DELETE,
 * new cleanup claim, token reset, receipt removal or quota release occurs here.
 */
export async function reauthorizeRetiredFileBackup(db:SqlDatabase,owner:string,input:{id:string;indexHash:string;newerId:string;newerSha256:string},options:{now:()=>string;services:FileBackupServices;signal?:AbortSignal}):Promise<RetiredFileBackupAuthorization>{
 if(!owner||owner.trim()!==owner||owner.length>256||/[\u0000-\u001f\u007f]/u.test(owner))throw new Error('An authenticated owner is required.');
 const command=z.object({id,indexHash:digest,newerId:id,newerSha256:digest}).strict().parse(input),now=stamp.parse(options.now());
 if(command.id===command.newerId)throw new Error('A different strictly newer file recovery point is required.');
 const old=await retired(db,owner,command.id,command.indexHash);
 const oldColumns=Object.keys(completeRetiredArchiveSchema.shape),oldObjectColumns=Object.keys(reauthorizationOldObjectSchema.shape),claimColumns=Object.keys(reauthorizationClaimSchema.shape);
 const archive=completeRetiredArchiveSchema.parse(await db.prepare('SELECT '+oldColumns.join(',')+' FROM backup_archives WHERE user_id=? AND id=?').bind(owner,command.id).first());
 const objects=z.array(reauthorizationOldObjectSchema).min(1).max(5).parse((await db.prepare('SELECT '+oldObjectColumns.join(',')+' FROM backup_archive_objects WHERE user_id=? AND archive_id=? ORDER BY part_number LIMIT 6').bind(owner,command.id).all()).results);
 if(objects.some(row=>row.pending_token!==null&&row.settled_at===null))throw new Error('An unsettled old upload cannot be reauthorized.');
 const claims=z.array(reauthorizationClaimSchema).max(5).parse((await db.prepare('SELECT '+claimColumns.map(column=>'c.'+column).join(',')+' FROM backup_archive_cleanup_claims c JOIN backup_archive_objects o ON o.storage_key=c.storage_key WHERE o.user_id=? AND o.archive_id=? ORDER BY c.storage_key LIMIT 6').bind(owner,command.id).all()).results);
 if(claims.some(claim=>claim.archive_id!==command.id||!objects.some(object=>object.storage_key===claim.storage_key&&object.part_number===claim.part_number)))throw new Error('Old cleanup claim identity differs.');
 const newer=await readyAuthorizationSide(db,owner,command.newerId);
 if(newer.logical.sha256!==command.newerSha256||newer.archive.namespace===archive.namespace||newer.objects.some(row=>row.pending_token!==null&&row.settled_at===null))throw new Error('The newer current file recovery point differs.');
 if(!(newer.logical.source_revision>archive.source_revision||newer.logical.source_revision===archive.source_revision&&Date.parse(newer.logical.created_at)>Date.parse(archive.created_at)))throw new Error('A strictly newer complete file recovery point is required.');
 if(Date.parse(archive.created_at)>Date.parse(now)||Date.parse(newer.logical.created_at)>Date.parse(now))throw new Error('Recovery point timestamps exceed the server clock.');
 const epoch=(await db.prepare('SELECT COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0) epoch').bind(owner).first<{epoch:number}>())!.epoch;z.number().int().nonnegative().safe().parse(epoch);
 const verified=await readReadyFileBackup(db,owner,command.newerId,options.services,options.signal);
 if(!verified)throw new Error('The newer complete file recovery point could not be verified.');
 await verified.stream.cancel();
 if(verified.indexHash!==newer.archive.index_sha256||verified.index.metadataSha256!==command.newerSha256)throw new Error('The newer complete file recovery point could not be verified.');
 if(options.signal?.aborted)throw new Error('Authorization cancelled.');
 // Retired parsing independently validates the old index hash and exact closed
 // namespace keys; capture all physical columns for the subsequent atomic CAS.
 if(canonical((await retired(db,owner,command.id,command.indexHash)))!==canonical(old))throw new Error('Retired recovery point changed during verification.');
 const clauses=['COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?','NOT EXISTS(SELECT 1 FROM workspace_backups WHERE user_id=? AND id=?)'],bindings:(string|number|null)[]=[owner,epoch,owner,command.id];
 const rowsets=[
 {table:'backup_archives',where:'user_id=? AND id=?',bind:[owner,command.id],columns:oldColumns,rows:[archive]},
 {table:'backup_archive_objects',where:'user_id=? AND archive_id=?',bind:[owner,command.id],columns:oldObjectColumns,rows:objects},
 {table:'workspace_backups',where:'user_id=? AND id=?',bind:[owner,command.newerId],columns:Object.keys(readySideSchema.shape.logical.shape),rows:[newer.logical]},
 {table:'backup_archives',where:'user_id=? AND id=?',bind:[owner,command.newerId],columns:Object.keys(readySideSchema.shape.archive.shape),rows:[newer.archive]},
 {table:'backup_archive_objects',where:'user_id=? AND archive_id=?',bind:[owner,command.newerId],columns:Object.keys(readySideSchema.shape.objects.element.shape),rows:newer.objects},
 {table:'backup_archive_cleanup_claims',where:'user_id=? AND storage_key IN(SELECT storage_key FROM backup_archive_objects WHERE user_id=? AND archive_id=?)',bind:[owner,owner,command.id],columns:claimColumns,rows:claims},
 ];
 for(const set of rowsets){clauses.push('(SELECT COUNT(*) FROM '+set.table+' WHERE '+set.where+')=? AND NOT EXISTS(SELECT '+set.columns.join(',')+' FROM '+set.table+' WHERE '+set.where+' EXCEPT SELECT '+set.columns.map(column=>"json_extract(value,'$."+column+"')").join(',')+' FROM json_each(?))');bindings.push(...set.bind,set.rows.length,...set.bind,canonical(set.rows));}
 clauses.push('NOT EXISTS(SELECT 1 FROM backup_archive_cleanup_claims c JOIN backup_archive_objects o ON o.storage_key=c.storage_key WHERE o.user_id=? AND o.archive_id=?)');bindings.push(owner,command.newerId);
 const capacity=await requirePrivateCapacity(db,owner,{growth:[await privateBackupUpdates(db,owner,'backup_archives','id=?',[command.id],{execution_epoch:epoch})]});clauses.push(capacity.sql);bindings.push(...capacity.bindings);
 const mutation='retired-backup-reauthorize-'+crypto.randomUUID(),token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)',binds=[owner,mutation,token];
 const result=await db.batch([
 db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 WHERE '+clauses.map(clause=>'('+clause+')').join(' AND ')).bind(...binds,...bindings),
 db.prepare('UPDATE backup_archives SET execution_epoch=? WHERE user_id=? AND id=? AND status=\'retired\' AND index_sha256=? AND '+gate).bind(epoch,owner,command.id,command.indexHash,...binds),
 db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...binds),
 ]);
 if(result[0].meta.changes!==1||result[1].meta.changes!==1)throw new Error('Recovery authority changed during verification.');
 return {status:'authorized',id:command.id,indexHash:command.indexHash,executionEpoch:epoch};
}

type PrivatePhysicalRow=Record<string,string|number|null>;
async function privateBackupUpdates(db:SqlDatabase,owner:string,table:PrivateGrowth['table'],where:string,bindings:(string|number|null)[],changes:PrivatePhysicalRow):Promise<PrivateGrowth>{
 const rows=(await db.prepare('SELECT * FROM '+table+' WHERE user_id=? AND '+where+' LIMIT 6').bind(owner,...bindings).all<PrivatePhysicalRow>()).results;
 if(rows.length>5)throw new Error('Private backup growth selection exceeds its bound.');
 return rows.reduce<PrivateGrowth>((total,row)=>{const growth=privateRowGrowth(table,null,{...row,...changes});return {table,bytes:total.bytes+growth.bytes,rows:0};},{table,bytes:0,rows:0});
}
