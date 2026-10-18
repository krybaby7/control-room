import {z} from 'zod';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceIdSchema as id,evidenceDateSchema as stamp} from '../evidence-validation.ts';
import {readWorkspaceBackup} from '../workspace-backups.ts';
import {readReadyFileBackup,backupArchiveIndexSchema,type FileBackupServices} from './backup-archive-store.ts';
import {backupArchiveKey} from '../backup-archive-storage.ts';
const count=z.number().int().nonnegative().safe(),positive=z.number().int().positive().safe(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const logicalSchema=z.object({id,source_revision:positive,created_at:stamp,reason:z.enum(['manual','restore','delete','repair','scheduled','migration']),bytes:positive.max(1_800_000),sha256:digest,content:z.string().max(1_800_000),status:z.literal('ready'),pinned:z.union([z.literal(0),z.literal(1)])}).strict();
const archiveSchema=z.object({id,namespace:z.string().uuid(),intent_id:id,source_revision:positive,source_sha256:digest,metadata_content:z.string().max(1_800_000),metadata_bytes:positive.max(1_800_000),execution_epoch:count,status:z.literal('ready'),created_at:stamp,updated_at:stamp,zip_bytes:positive.max(20_000_000),files:count.max(500),file_bytes:count.max(20_000_000),chunk_count:positive.max(5),index_json:z.string().max(10000),index_sha256:digest}).strict();
const objectSchema=z.object({part_number:count.max(4),storage_key:z.string().max(200),bytes:positive.max(4*1024*1024),sha256:digest,created_at:stamp,verified_at:stamp,purged_at:z.null(),pending_token:z.string().uuid().nullable(),settled_at:stamp.nullable()}).strict();
const sideSchema=z.object({logical:logicalSchema,archive:archiveSchema,objects:z.array(objectSchema).min(1).max(5)}).strict();
export const fileBackupRemovalControlSchema=z.object({selected:sideSchema,newer:sideSchema}).strict();
export type FileBackupRemovalControl=z.infer<typeof fileBackupRemovalControlSchema>;
const logicalColumns=['id','source_revision','created_at','reason','bytes','sha256','content','status','pinned'] as const;
const archiveColumns=['id','namespace','intent_id','source_revision','source_sha256','metadata_content','metadata_bytes','execution_epoch','status','created_at','updated_at','zip_bytes','files','file_bytes','chunk_count','index_json','index_sha256'] as const;
const objectColumns=['part_number','storage_key','bytes','sha256','created_at','verified_at','purged_at','pending_token','settled_at'] as const;
async function side(db:SqlDatabase,owner:string,selectedId:string){
 const logical=await db.prepare('SELECT '+logicalColumns.join(',')+' FROM workspace_backups WHERE user_id=? AND id=?').bind(owner,selectedId).first();
 const archive=await db.prepare('SELECT '+archiveColumns.join(',')+' FROM backup_archives WHERE user_id=? AND id=?').bind(owner,selectedId).first();
 const objects=(await db.prepare('SELECT '+objectColumns.join(',')+' FROM backup_archive_objects WHERE user_id=? AND archive_id=? ORDER BY part_number LIMIT 6').bind(owner,selectedId).all()).results;
 const result=sideSchema.parse({logical,archive,objects}),index=backupArchiveIndexSchema.parse(JSON.parse(result.archive.index_json));
 if(await contentHash(result.logical.content)!==result.logical.sha256||await contentHash(canonical(index))!==result.archive.index_sha256||index.metadataSha256!==result.logical.sha256||result.logical.id!==result.archive.id||result.logical.source_revision!==result.archive.source_revision||result.logical.sha256!==result.archive.source_sha256||result.logical.content!==result.archive.metadata_content||result.logical.bytes!==result.archive.metadata_bytes||index.archiveId!==selectedId||index.chunks.length!==objects.length||result.objects.some((object,part)=>object.part_number!==part||object.storage_key!==backupArchiveKey(result.archive.namespace,part)||object.bytes!==index.chunks[part].bytes||object.sha256!==index.chunks[part].sha256))throw new Error('The exact retained file recovery point is unavailable.');
 return result;
}
/** A server-owned helper performs actual newer R2/ZIP verification. No request boolean grants deletion authority. */
export async function prepareFileBackupRemoval(db:SqlDatabase,owner:string,input:{id:string;sha256:string;newerId:string;newerSha256:string},services:FileBackupServices,now:string):Promise<FileBackupRemovalControl>{
 const parsed=z.object({id,sha256:digest,newerId:id,newerSha256:digest}).strict().parse(input);stamp.parse(now);
 if(!owner||owner.trim()!==owner||owner.length>256||parsed.id===parsed.newerId)throw new Error('Select a different owner recovery point.');
 const selected=await readWorkspaceBackup(db,owner,parsed.id),newer=await readWorkspaceBackup(db,owner,parsed.newerId);
 if(!selected||!newer||selected.manifest.sha256!==parsed.sha256||newer.manifest.sha256!==parsed.newerSha256||selected.manifest.fileArchive?.status!=='ready'||newer.manifest.fileArchive?.status!=='ready')throw new Error('Two exact owner file recovery points are required.');
 if(!(newer.manifest.sourceRevision>selected.manifest.sourceRevision||newer.manifest.sourceRevision===selected.manifest.sourceRevision&&Date.parse(newer.manifest.createdAt)>Date.parse(selected.manifest.createdAt)))throw new Error('A strictly newer complete file recovery point is required.');
 const full=await readReadyFileBackup(db,owner,parsed.newerId,services);if(!full)throw new Error('The newer complete file archive could not be verified.');void full.stream.cancel().catch(()=>{});
 const proof=fileBackupRemovalControlSchema.parse({selected:await side(db,owner,parsed.id),newer:await side(db,owner,parsed.newerId)});
 if(proof.selected.logical.sha256!==parsed.sha256||proof.newer.logical.sha256!==parsed.newerSha256||proof.newer.archive.index_sha256!==full.indexHash)throw new Error('The recovery points changed during verification.');
 return proof;
}
/** Root must bind selected/newer IDs and hashes to its explicit backup.remove plan.
 * Same atomic claim retires private metadata and deletes the selected logical row.
 * Physical objects, pending tokens and permanent keys are deliberately retained. */
export function fileBackupRemovalStatements(db:SqlDatabase,owner:string,input:FileBackupRemovalControl,now:string,gate:string,binds:(string|number|null)[],mutationId:string):SqlStatement[]{
 const proof=fileBackupRemovalControlSchema.parse(input);stamp.parse(now);
 const assert=(sql:string,values:(string|number|null)[])=>db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+sql+' THEN 1 ELSE 0 END WHERE '+gate).bind(owner,mutationId,...values,...binds);
 const statements:SqlStatement[]=[];
 for(const entry of [proof.selected,proof.newer]){
  statements.push(assert('EXISTS(SELECT 1 FROM workspace_backups WHERE user_id=? AND '+logicalColumns.map(column=>column+'=?').join(' AND ')+')',[owner,...logicalColumns.map(column=>entry.logical[column])]));
  statements.push(assert('EXISTS(SELECT 1 FROM backup_archives WHERE user_id=? AND '+archiveColumns.map(column=>column+'=?').join(' AND ')+')',[owner,...archiveColumns.map(column=>entry.archive[column])]));
  statements.push(assert('(SELECT COUNT(*) FROM backup_archive_objects WHERE user_id=? AND archive_id=?)=? AND NOT EXISTS(SELECT '+objectColumns.join(',')+' FROM backup_archive_objects WHERE user_id=? AND archive_id=? EXCEPT SELECT '+objectColumns.map(column=>"json_extract(value,'$."+column+"')").join(',')+' FROM json_each(?))',[owner,entry.logical.id,entry.objects.length,owner,entry.logical.id,canonical(entry.objects)]));
 }
 statements.push(assert('NOT EXISTS(SELECT 1 FROM backup_archive_cleanup_claims c JOIN backup_archive_objects o ON o.storage_key=c.storage_key WHERE o.user_id=? AND o.archive_id=?)',[owner,proof.newer.logical.id]));
 statements.push(assert('EXISTS(SELECT 1 FROM workspace_backups newer JOIN workspace_backups old ON old.user_id=newer.user_id WHERE old.user_id=? AND old.id=? AND newer.id=? AND (newer.source_revision>old.source_revision OR newer.source_revision=old.source_revision AND julianday(newer.created_at)>julianday(old.created_at)))',[owner,proof.selected.logical.id,proof.newer.logical.id]));
 statements.push(db.prepare("UPDATE backup_archives SET status='retired',metadata_content=NULL,metadata_bytes=0,updated_at=? WHERE user_id=? AND id=? AND status='ready' AND index_sha256=? AND "+gate).bind(now,owner,proof.selected.logical.id,proof.selected.archive.index_sha256,...binds));
 return statements;
}
