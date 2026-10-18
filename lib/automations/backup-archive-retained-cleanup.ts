import {z} from 'zod';
import type {SqlDatabase} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceIdSchema as id,evidenceDateSchema as stamp} from '../evidence-validation.ts';
import {readReadyFileBackup,backupArchiveIndexSchema,type FileBackupServices,type BackupArchiveIndex} from './backup-archive-store.ts';
import {fileBackupRemovalControlSchema,type FileBackupRemovalControl} from './backup-archive-removal.ts';
import {backupArchiveKey,createBackupArchiveStorage} from '../backup-archive-storage.ts';
import type {BackupArchiveCleanupBucket,FileBackupCleanupResult} from './backup-archive-cleanup.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().nonnegative().safe();
const retainedSchema=z.object({storage_key:z.string().max(200),source_archive_id:id,part_number:integer.max(4),namespace:z.string().uuid(),bytes:integer.min(1).max(4194304),sha256:digest,created_at:stamp,verified_at:stamp,purged_at:stamp.nullable()}).strict();
type Retained=z.infer<typeof retainedSchema>;
type Side=FileBackupRemovalControl['selected'];
interface Generation {side:Side;index:BackupArchiveIndex;rows:Retained[];hash:string;epoch:number}
const retainedColumns=Object.keys(retainedSchema.shape),sideSchema=fileBackupRemovalControlSchema.shape.selected;
const logicalColumns=Object.keys(sideSchema.shape.logical.shape),archiveColumns=Object.keys(sideSchema.shape.archive.shape),objectColumns=Object.keys(sideSchema.shape.objects.element.shape);
function ownerRequired(owner:string){if(!owner||owner.trim()!==owner||owner.length>256||/[\u0000-\u001f\u007f]/u.test(owner))throw new Error('An authenticated owner is required.');}
async function side(db:SqlDatabase,owner:string,archiveId:string):Promise<Side>{
 return sideSchema.parse({
 logical:await db.prepare('SELECT '+logicalColumns.join(',')+' FROM workspace_backups WHERE user_id=? AND id=?').bind(owner,archiveId).first(),
 archive:await db.prepare('SELECT '+archiveColumns.join(',')+' FROM backup_archives WHERE user_id=? AND id=?').bind(owner,archiveId).first(),
 objects:(await db.prepare('SELECT '+objectColumns.join(',')+' FROM backup_archive_objects WHERE user_id=? AND archive_id=? ORDER BY part_number LIMIT 6').bind(owner,archiveId).all()).results,
 });
}
async function generationHash(rows:Retained[]):Promise<string>{
 return contentHash(canonical(rows.map(row=>({archiveId:row.source_archive_id,namespace:row.namespace,part:row.part_number,bytes:row.bytes,sha256:row.sha256}))));
}
async function load(db:SqlDatabase,owner:string,input:{id:string;indexHash:string;generationHash:string},namespace?:string):Promise<Generation>{
 const current=await side(db,owner,input.id),index=backupArchiveIndexSchema.parse(JSON.parse(current.archive.index_json));
 if(current.archive.index_sha256!==input.indexHash||await contentHash(canonical(index))!==input.indexHash||index.archiveId!==input.id||current.logical.sha256!==index.metadataSha256)throw new Error('Current ready archive identity differs.');
 // Only the first unpurged generation is advertised. The opaque hash, never a
 // caller-supplied namespace or key, selects that exact independently read set.
 const selected=namespace??(await db.prepare('SELECT namespace FROM backup_archive_retained_objects WHERE user_id=? AND source_archive_id=? AND purged_at IS NULL ORDER BY namespace LIMIT 1').bind(owner,input.id).first<{namespace:string}>())?.namespace;
 if(!selected)throw new Error('Retained generation is unavailable.');
 const rows=z.array(retainedSchema).min(1).max(5).parse((await db.prepare('SELECT '+retainedColumns.join(',')+' FROM backup_archive_retained_objects WHERE user_id=? AND source_archive_id=? AND namespace=? ORDER BY part_number LIMIT 6').bind(owner,input.id,selected).all()).results);
 const hash=await generationHash(rows);
 if(hash!==input.generationHash||selected===current.archive.namespace||rows.length!==index.chunks.length||rows.some((row,part)=>row.source_archive_id!==input.id||row.namespace!==selected||row.part_number!==part||row.storage_key!==backupArchiveKey(selected,part)||row.sha256!==index.chunks[part].sha256||row.bytes!==index.chunks[part].bytes))throw new Error('Retained parts do not match the current complete archive.');
 if(current.objects.some(row=>row.pending_token!==null&&row.settled_at===null))throw new Error('Current archive has an unsettled upload.');
 for(const row of rows)if(await db.prepare('SELECT 1 FROM backup_archive_objects WHERE storage_key=? LIMIT 1').bind(row.storage_key).first())throw new Error('A retained key is still a current archive object.');
 const epoch=(await db.prepare('SELECT COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0) epoch').bind(owner).first<{epoch:number}>())!.epoch;integer.parse(epoch);
 return {side:current,index,rows,hash,epoch};
}
function proof(owner:string,value:Generation):{sql:string;bindings:(string|number|null)[]}{
 const clauses=['COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?'],bindings:(string|number|null)[]=[owner,value.epoch];
 const parts=[
 {table:'workspace_backups',where:'user_id=? AND id=?',bind:[owner,value.side.logical.id],columns:logicalColumns,rows:[value.side.logical]},
 {table:'backup_archives',where:'user_id=? AND id=?',bind:[owner,value.side.archive.id],columns:archiveColumns,rows:[value.side.archive]},
 {table:'backup_archive_objects',where:'user_id=? AND archive_id=?',bind:[owner,value.side.archive.id],columns:objectColumns,rows:value.side.objects},
 {table:'backup_archive_retained_objects',where:'user_id=? AND source_archive_id=? AND namespace=?',bind:[owner,value.side.archive.id,value.rows[0].namespace],columns:retainedColumns,rows:value.rows},
 ];
 for(const part of parts){clauses.push('(SELECT COUNT(*) FROM '+part.table+' WHERE '+part.where+')=? AND NOT EXISTS(SELECT '+part.columns.join(',')+' FROM '+part.table+' WHERE '+part.where+' EXCEPT SELECT '+part.columns.map(column=>"json_extract(value,'$."+column+"')").join(',')+' FROM json_each(?))');bindings.push(...part.bind,part.rows.length,...part.bind,canonical(part.rows));}
 clauses.push('NOT EXISTS(SELECT 1 FROM backup_archive_objects WHERE storage_key IN(SELECT json_extract(value,\'$.storage_key\') FROM json_each(?)))');bindings.push(canonical(value.rows));
 return {sql:clauses.map(clause=>'('+clause+')').join(' AND '),bindings};
}
async function settle(db:SqlDatabase,owner:string,value:Generation,row:Retained,token:string,now:string){
 const guard=proof(owner,value),mutation='retained-backup-cleanup-'+crypto.randomUUID(),claim=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)',binds=[owner,mutation,claim];
 await db.batch([
 db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 WHERE '+guard.sql+' AND EXISTS(SELECT 1 FROM backup_archive_cleanup_claims WHERE user_id=? AND storage_key=? AND archive_id=? AND part_number=? AND token=?)').bind(...binds,...guard.bindings,owner,row.storage_key,row.source_archive_id,row.part_number,token),
 db.prepare('UPDATE backup_archive_retained_objects SET purged_at=? WHERE user_id=? AND storage_key=? AND purged_at IS NULL AND '+gate).bind(now,owner,row.storage_key,...binds),
 db.prepare('UPDATE backup_archive_cleanup_claims SET purged_at=COALESCE(purged_at,?) WHERE user_id=? AND storage_key=? AND token=? AND '+gate).bind(now,owner,row.storage_key,token,...binds),
 db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...binds),
 ]);
}
export interface RetainedFileBackupSummary {id:string;indexHash:string;generationHash:string;files:number;archiveBytes:number;chargedBytes:number;chargedParts:number;pendingCleanupCount:number}
/** One retained generation per ready archive; refresh reveals the next generation
 * after explicit cleanup. Cursor contains only a public logical backup ID. */
export async function listRetainedFileBackupGenerations(db:SqlDatabase,owner:string,options:{after?:string;limit?:number}={}):Promise<{items:RetainedFileBackupSummary[];nextAfter:string|null}>{
 ownerRequired(owner);const parsed=z.object({after:id.optional(),limit:integer.min(1).max(50).optional()}).strict().parse(options),limit=parsed.limit??50;
 const candidates=(await db.prepare("SELECT a.id,a.index_sha256,r.namespace FROM backup_archives a JOIN backup_archive_retained_objects r ON r.user_id=a.user_id AND r.source_archive_id=a.id WHERE a.user_id=? AND a.status='ready' AND a.id>? AND r.purged_at IS NULL AND r.namespace=(SELECT MIN(old.namespace) FROM backup_archive_retained_objects old WHERE old.user_id=a.user_id AND old.source_archive_id=a.id AND old.purged_at IS NULL) GROUP BY a.id,a.index_sha256,r.namespace ORDER BY a.id LIMIT ?").bind(owner,parsed.after??'',limit+1).all<{id:string;index_sha256:string;namespace:string}>()).results;
 const items:RetainedFileBackupSummary[]=[];
 for(const candidate of candidates.slice(0,limit)){
  const rows=z.array(retainedSchema).min(1).max(5).parse((await db.prepare('SELECT '+retainedColumns.join(',')+' FROM backup_archive_retained_objects WHERE user_id=? AND source_archive_id=? AND namespace=? ORDER BY part_number LIMIT 6').bind(owner,candidate.id,candidate.namespace).all()).results),hash=await generationHash(rows);
  const value=await load(db,owner,{id:candidate.id,indexHash:candidate.index_sha256,generationHash:hash},candidate.namespace);
  const pending=(await db.prepare('SELECT COUNT(*) n FROM backup_archive_cleanup_claims WHERE user_id=? AND purged_at IS NULL AND storage_key IN(SELECT storage_key FROM backup_archive_retained_objects WHERE user_id=? AND source_archive_id=? AND namespace=?)').bind(owner,owner,candidate.id,candidate.namespace).first<{n:number}>())!.n;
  items.push({id:id.parse(candidate.id),indexHash:digest.parse(candidate.index_sha256),generationHash:hash,files:value.index.files,archiveBytes:value.index.zipBytes,chargedBytes:value.rows.filter(row=>row.purged_at===null).reduce((sum,row)=>sum+row.bytes,0),chargedParts:value.rows.filter(row=>row.purged_at===null).length,pendingCleanupCount:integer.max(5).parse(pending)});
 }
 return {items,nextAfter:candidates.length>limit?items.at(-1)!.id:null};
}
/** Fresh authenticated owner intent is mandatory at the calling route. Imported
 * retained rows and old cleanup claims alone are never authority to DELETE. */
export async function cleanupRetainedFileBackup(db:SqlDatabase,owner:string,input:{id:string;indexHash:string;generationHash:string},options:{now:()=>string;services?:FileBackupServices&{bucket:BackupArchiveCleanupBucket};signal?:AbortSignal;deleteDeadlineMs?:number}):Promise<FileBackupCleanupResult>{
 ownerRequired(owner);const command=z.object({id,indexHash:digest,generationHash:digest}).strict().parse(input),deadlineMs=integer.min(1).max(15000).parse(options.deleteDeadlineMs??15000);
 let value=await load(db,owner,command),purgedParts=0;
 const result=(status:FileBackupCleanupResult['status'],reason?:FileBackupCleanupResult['reason']):FileBackupCleanupResult=>({status,...(reason?{reason}:{}),purgedParts,retainedBytes:value.rows.filter(row=>row.purged_at===null).reduce((sum,row)=>sum+row.bytes,0),physicalDeletion:purgedParts>0});
 if(!options.services)return result('blocked','storage_unavailable');
 const services=options.services,budget=new AbortController(),timer=setTimeout(()=>budget.abort(),15000),signal=options.signal?AbortSignal.any([options.signal,budget.signal]):budget.signal;
 try{
  // Complete independent native ZIP, manifest, attachment and physical-ledger
  // verification occurs before a single old-key cleanup claim or DELETE.
  const verified=await readReadyFileBackup(db,owner,command.id,services,signal);
  if(!verified||verified.indexHash!==command.indexHash||canonical(verified.index)!==canonical(value.index))return result('blocked','storage_unavailable');
  await verified.stream.cancel();
  const checked=await load(db,owner,command,value.rows[0].namespace);
  if(canonical(checked)!==canonical(value))return result('blocked','authorization_stale');
  const storage=createBackupArchiveStorage(services.bucket);
  for(const initial of value.rows){
   if(initial.purged_at!==null)continue;if(signal.aborted)return result('partial');
   const row=value.rows[initial.part_number],guard=proof(owner,value),now=stamp.parse(options.now());
   const present=await storage.get(row.namespace,value.index.chunks[row.part_number],signal);
   const previous=await db.prepare('SELECT archive_id,part_number,token FROM backup_archive_cleanup_claims WHERE user_id=? AND storage_key=?').bind(owner,row.storage_key).first<{archive_id:string;part_number:number;token:string}>();
   if(previous&&(previous.archive_id!==command.id||previous.part_number!==row.part_number||!z.string().uuid().safeParse(previous.token).success))throw new Error('Cleanup claim identity differs.');
   if(previous&&present)return result('uncertain','cleanup_unconfirmed');
   const token=previous?.token??crypto.randomUUID();
   await db.prepare('INSERT OR IGNORE INTO backup_archive_cleanup_claims(user_id,storage_key,archive_id,part_number,token,claimed_at,purged_at) SELECT ?,?,?,?,?,?,NULL WHERE '+guard.sql).bind(owner,row.storage_key,command.id,row.part_number,token,now,...guard.bindings).run();
   // INSERT OR IGNORE may observe a concurrent winner. Only this invocation's
   // newly inserted token can authorize a first DELETE; never repeat another.
   const admitted=await db.prepare('SELECT 1 WHERE '+guard.sql+' AND EXISTS(SELECT 1 FROM backup_archive_cleanup_claims WHERE user_id=? AND storage_key=? AND token=?)').bind(...guard.bindings,owner,row.storage_key,token).first();
   if(!admitted)return result('blocked','authorization_stale');
   if(signal.aborted)return result('partial');
   if(present){let timeout:ReturnType<typeof setTimeout>|undefined,stop=()=>{};const uncertain=new Promise<never>((_,reject)=>{stop=()=>reject(new Error('DELETE outcome is unconfirmed.'));signal.addEventListener('abort',stop,{once:true});timeout=setTimeout(stop,deadlineMs);});try{await Promise.race([services.bucket.delete(row.storage_key),uncertain]);}finally{clearTimeout(timeout);signal.removeEventListener('abort',stop);}}
   // Safe settlement may finish after request cancellation, but every read is
   // independently bounded and absent bytes are required before releasing quota.
   if(await storage.get(row.namespace,value.index.chunks[row.part_number]))throw new Error('Old generation is still present.');
   await settle(db,owner,value,row,token,stamp.parse(options.now()));
   value=await load(db,owner,command,row.namespace);
   if(value.rows[row.part_number].purged_at===null)throw new Error('Purge settlement is unconfirmed.');purgedParts++;
  }
  return result('completed');
 }catch{return result('uncertain','cleanup_unconfirmed');}finally{clearTimeout(timer);}
}
