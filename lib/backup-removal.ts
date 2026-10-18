import {z} from 'zod';
import type {BackupManifest} from './workspace-backups.ts';
import type {listWorkspaceBackups,readWorkspaceBackup} from './workspace-backups.ts';
import type {CommandHandler,PrepareContext,MutationPlan} from './workspace-transaction.ts';
export interface BackupRemoval {id:string;sha256:string;newerId:string;newerSha256:string;}
export interface BackupRemovalReader {get(id:string):ReturnType<typeof readWorkspaceBackup>;list():ReturnType<typeof listWorkspaceBackups>;}
type RemovalContext=PrepareContext & {backups?:BackupRemovalReader};
const digest=/^[a-f0-9]{64}$/;
const commandSchema=z.object({type:z.literal('workspace.backup.remove'),id:z.string().min(1).max(128),sha256:z.string().regex(digest),targetRevision:z.number().int().positive()}).strict();
function validReady(manifest:BackupManifest):boolean {
 return manifest.status==='ready' && digest.test(manifest.sha256) && Number.isSafeInteger(manifest.sourceRevision) && manifest.sourceRevision>0 && Number.isFinite(Date.parse(manifest.createdAt)) && manifest.bytes>0 && Number.isSafeInteger(manifest.bytes) && manifest.missingAttachments.length===0 && manifest.completeModules.includes('planning');
}
function newerThan(candidate:BackupManifest,selected:BackupManifest):boolean {
 return candidate.sourceRevision>selected.sourceRevision || candidate.sourceRevision===selected.sourceRevision && Date.parse(candidate.createdAt)>Date.parse(selected.createdAt);
}
/** Input must come from digest-verified owner reads; this helper cannot authenticate a client-supplied manifest. */
export function prepareBackupRemoval(currentList:readonly BackupManifest[],id:string,expectedSha:string):{selected:BackupManifest;newer:BackupManifest} {
 if(typeof id!=='string'||!id||id.length>128||!digest.test(expectedSha))throw new Error('Invalid backup removal identity.');
 if(new Set(currentList.map(item=>item.id)).size!==currentList.length)throw new Error('Duplicate backup identities.');
 const selected=currentList.find(item=>item.id===id);
 if(!selected||!validReady(selected)||selected.sha256!==expectedSha)throw new Error('Selected backup is unavailable or its digest changed.');
 const newer=currentList.filter(item=>item.id!==selected.id && item.ownerScope===selected.ownerScope && validReady(item) && newerThan(item,selected)).sort((a,b)=>b.sourceRevision-a.sourceRevision || Date.parse(b.createdAt)-Date.parse(a.createdAt) || a.id.localeCompare(b.id))[0];
 if(!newer)throw new Error('Retain a newer verified recovery point before removing this snapshot.');
 return {selected:structuredClone(selected),newer:structuredClone(newer)};
}
export async function prepareBackupRemovalCommand(context:RemovalContext):Promise<MutationPlan & {backupRemoval:BackupRemoval}> {
 const command=commandSchema.parse(context.command);
 if(!context.userId||context.before.revision!==command.targetRevision)throw new Error('Backup removal preview is stale.');
 if(!context.backups)throw new Error('Verified backup reads are unavailable.');
 const listed=await context.backups.list();
 if(listed.some(item=>item.ownerScope!==context.userId))throw new Error('Backup owner scope is invalid.');
 const preview=prepareBackupRemoval(listed,command.id,command.sha256);
 const selected=await context.backups.get(preview.selected.id);const newer=await context.backups.get(preview.newer.id);
 if(!selected||!newer || selected.manifest.ownerScope!==context.userId || newer.manifest.ownerScope!==context.userId)throw new Error('Backup recovery point is no longer available.');
 const checked=prepareBackupRemoval([selected.manifest,newer.manifest],command.id,command.sha256);
 if(checked.newer.sha256!==preview.newer.sha256 || checked.newer.id!==preview.newer.id)throw new Error('Backup recovery point changed during review.');
 return {planningAfter:context.before.workspace,writes:[],jobs:[],backupRemoval:{id:checked.selected.id,sha256:checked.selected.sha256,newerId:checked.newer.id,newerSha256:checked.newer.sha256},events:[{id:crypto.randomUUID(),kind:'workspace.backup.remove',entityType:'backup',entityId:checked.selected.id,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:checked.selected.sha256,undoOf:null}]};
}
/** Explicit owner removal only. The transaction compiler must reassert both ready digests and ordering atomically. */
export const backupRemovalHandler:CommandHandler={prepare:prepareBackupRemovalCommand};
