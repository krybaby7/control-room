import type { WorkspaceEnvelope } from './types.ts';
import type { SqlDatabase } from './workspace-store.ts';
import { readCurrent } from './workspace-store.ts';
import { canonical, contentHash, exportWorkspaceBundle, parseWorkspaceBundle, type WorkspaceBundle } from './workspace-export.ts';
export const BACKUP_LIMITS = Object.freeze({snapshots:10,ownerBytes:20_000_000,d1BundleBytes:1_800_000});
export type BackupReason='manual'|'restore'|'delete'|'repair'|'scheduled'|'migration';
export interface BackupManifest {
 id:string;ownerScope:string;sourceRevision:number;reason:BackupReason;createdAt:string;formatVersion:1;bytes:number;sha256:string;
 storageKind:'d1'|'r2';storageKey:string;status:'preparing'|'ready'|'failed'|'expired';expiresAt:string|null;completeModules:string[];missingAttachments:string[];
}
interface BackupRow {id:string;source_revision:number;created_at:string;reason:BackupReason;bytes:number;sha256:string;content:string;status:BackupManifest['status'];pinned:number;}
export class BackupCapacityError extends Error {}
export class BackupIntegrityError extends Error {}
function owner(userId:string):void {if(!userId)throw new Error('A signed-in owner is required.');}
function manifest(row:BackupRow,userId:string,bundle:WorkspaceBundle):BackupManifest {
 return {id:row.id,ownerScope:userId,sourceRevision:row.source_revision,reason:row.reason,createdAt:row.created_at,formatVersion:1,bytes:row.bytes,sha256:row.sha256,storageKind:'d1',storageKey:row.id,status:row.status,expiresAt:null,completeModules:['planning',...Object.keys(bundle.modules).sort()],missingAttachments:bundle.attachments.filter(item=>item.availability!=='included').map(item=>item.id)};
}
async function verify(row:BackupRow,userId:string):Promise<{manifest:BackupManifest;bundle:WorkspaceBundle;content:string;pinned:boolean}> {
 if(new TextEncoder().encode(row.content).length!==row.bytes || row.bytes>BACKUP_LIMITS.d1BundleBytes || await contentHash(row.content)!==row.sha256) throw new BackupIntegrityError('Backup bytes or digest do not match.');
 let bundle:WorkspaceBundle;try {bundle=parseWorkspaceBundle(JSON.parse(row.content));}catch {throw new BackupIntegrityError('Backup bundle is invalid or unsupported.');}
 if(bundle.source.workspaceRevision!==row.source_revision || !Number.isFinite(Date.parse(row.created_at)))throw new BackupIntegrityError('Backup source metadata does not match.');
 if(bundle.attachments.length)throw new BackupIntegrityError('D1 attachment recovery is unavailable.');
 return {manifest:manifest(row,userId,bundle),bundle,content:row.content,pinned:!!row.pinned};
}
/** Read-only preparation. The caller must insert under the command claim and reassert quota/source revision atomically. */
export async function prepareWorkspaceBackup(db:SqlDatabase,userId:string,before:WorkspaceEnvelope,reason:BackupReason,now:string):Promise<{manifest:BackupManifest;content:string}> {
 owner(userId);if(!['manual','restore','delete','repair','scheduled','migration'].includes(reason)||!Number.isFinite(Date.parse(now)))throw new Error('Invalid backup reason or timestamp.');
 const usage=await db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM workspace_backups WHERE user_id = ?').bind(userId).first<{count:number;bytes:number}>();
 if(!usage || usage.count>=BACKUP_LIMITS.snapshots)throw new BackupCapacityError('Backup snapshot limit reached. Remove a selected snapshot or configure storage; pinned/manual backups are retained.');
 const bundle=await exportWorkspaceBundle(db,userId,{now:()=>now});
 if(bundle.source.workspaceRevision!==before.revision || canonical(bundle.planning)!==canonical(before.workspace))throw new Error('Workspace changed before backup preparation.');
 if(bundle.attachments.length)throw new BackupCapacityError('Attachment bytes cannot be recovered by D1 fallback.');
 const content=JSON.stringify(bundle);const bytes=new TextEncoder().encode(content).length;
 if(bytes>BACKUP_LIMITS.d1BundleBytes)throw new BackupCapacityError('Backup exceeds the 1.8 MB D1 fallback bound; configure object storage.');
 if(usage.bytes+bytes>BACKUP_LIMITS.ownerBytes)throw new BackupCapacityError('Owner backup byte budget exceeded; existing snapshots were retained.');
 const current=await readCurrent(db,userId,now);if(current.revision!==before.revision || canonical(current.workspace)!==canonical(before.workspace))throw new Error('Workspace changed during backup preparation.');
 const id=crypto.randomUUID();const sha256=await contentHash(content);
 return {manifest:{id,ownerScope:userId,sourceRevision:before.revision,reason,createdAt:now,formatVersion:1,bytes,sha256,storageKind:'d1',storageKey:id,status:'ready',expiresAt:null,completeModules:['planning',...Object.keys(bundle.modules).sort()],missingAttachments:[]},content};
}
export async function readWorkspaceBackup(db:SqlDatabase,userId:string,id:string):Promise<{manifest:BackupManifest;bundle:WorkspaceBundle;content:string;pinned:boolean}|null> {
 owner(userId);const row=await db.prepare('SELECT id, source_revision, created_at, reason, bytes, sha256, content, status, pinned FROM workspace_backups WHERE user_id = ? AND id = ?').bind(userId,id).first<BackupRow>();
 if(!row)return null;const result=await verify(row,userId);if(row.status!=='ready')throw new BackupIntegrityError('Backup is not ready for recovery.');return result;
}
export async function listWorkspaceBackups(db:SqlDatabase,userId:string):Promise<Array<BackupManifest & {pinned:boolean}>> {
 owner(userId);const rows=(await db.prepare('SELECT id, source_revision, created_at, reason, bytes, sha256, content, status, pinned FROM workspace_backups WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(userId,BACKUP_LIMITS.snapshots+1).all<BackupRow>()).results;
 if(rows.length>BACKUP_LIMITS.snapshots)throw new BackupCapacityError('Backup snapshot quota exceeded.');
 let total=0;const result:Array<BackupManifest & {pinned:boolean}>=[];
 for(const row of rows){total+=row.bytes;const checked=await verify(row,userId);result.push({...checked.manifest,pinned:checked.pinned});}
 if(total>BACKUP_LIMITS.ownerBytes)throw new BackupCapacityError('Backup byte quota exceeded.');return result;
}
