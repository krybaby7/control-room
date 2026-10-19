import {z} from 'zod';
import {canonical,contentHash} from './canonical-json.ts';
import {attachmentRecordSchema,attachmentUsageSchema} from './evidence-module.ts';
import {OWNER_TABLES,ownerReader} from './workspace-modules.ts';
import type {MutationPlan} from './workspace-transaction.ts';
import type {WorkspaceCommand} from './workspace-protocol.ts';
import type {Workspace} from './types.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {CommandValidationError} from './workspace-errors.ts';
const marker=z.object({id:z.string().min(1).max(128),storageKey:z.string().min(1).max(500)}).strict();
function reject():never{throw new CommandValidationError('Metadata discard requires an exact unreferenced quarantine without physical identity.');}
/** The server callback is preparation only; the compiler also asserts absence of
 * every owned physical generation in the same transaction as these two writes. */
export async function validateAttachmentMetadataDiscard(db:SqlDatabase,owner:string,command:WorkspaceCommand,plan:MutationPlan,before:Workspace):Promise<void>{
 const selected=marker.parse(plan.attachmentMetadataDiscard);
 const allowed=new Set(['attachmentMetadataDiscard','planningAfter','referenceSnapshot','writes','jobs','events','preconditions']);
 if(Object.keys(plan).some(key=>!allowed.has(key))||command.type!=='attachment.retire'||command.reason!=='owner-delete'||command.id!==selected.id||canonical(plan.planningAfter)!==canonical(before)||plan.jobs.length||plan.writes.length!==2||plan.events.length!==1||plan.events[0].kind!=='attachment.retire'||plan.events[0].entityId!==selected.id)reject();
 const snapshot=plan.referenceSnapshot;
 if(!snapshot||canonical(snapshot.coveredModules)!==canonical(OWNER_TABLES)||snapshot.rows.length>10000||new Set(snapshot.rows.map(row=>row.module+'\u0000'+row.id)).size!==snapshot.rows.length||await contentHash(canonical({coveredModules:snapshot.coveredModules,rows:snapshot.rows}))!==snapshot.digest||snapshot.rows.some(row=>row.references.some(ref=>ref.kind==='attachment'&&ref.id===selected.id)))reject();
 const reader=ownerReader(db,owner),row=await reader.get('attachments',selected.id);if(!row)reject();
 const original=attachmentRecordSchema.parse(JSON.parse(row.payload_json)),write=plan.writes.find(item=>item.table==='attachments'&&item.id===selected.id);
 if(original.id!==selected.id||original.status!=='quarantined'||original.storageKey!==selected.storageKey||await contentHash(canonical(original))!==row.content_hash||!write||write.operation!=='update'||write.expectedRowRevision!==row.row_revision||canonical(write.value)!==canonical({...original,status:'deleted'}))reject();
 const exact=snapshot.rows.find(item=>item.module==='attachments'&&item.id===selected.id);if(!exact||exact.contentHash!==row.content_hash||exact.rowRevision!==row.row_revision)reject();
 let after='',files=0,bytes=0,count=0;for(;;){const page=await reader.list('attachments',{after,limit:200});for(const item of page){if(item.id<=after||++count>10000)reject();after=item.id;const value=attachmentRecordSchema.parse(JSON.parse(item.payload_json));if(value.id!==item.id||await contentHash(canonical(value))!==item.content_hash)reject();const frozen=snapshot.rows.find(f=>f.module==='attachments'&&f.id===item.id);if(!frozen||frozen.rowRevision!==item.row_revision||frozen.contentHash!==item.content_hash)reject();if(value.status!=='deleted'){files++;bytes+=value.expectedBytes;}}if(page.length<200)break;}
 const quota=await reader.get('attachment_usage','quota'),quotaWrite=plan.writes.find(item=>item.table==='attachment_usage'&&item.id==='quota');
 if(quota){const usage=attachmentUsageSchema.parse(JSON.parse(quota.payload_json));if(usage.files!==files||usage.bytes!==bytes||await contentHash(canonical(usage))!==quota.content_hash)reject();}
 if(!quotaWrite||quotaWrite.operation!==(quota?'update':'insert')||quotaWrite.expectedRowRevision!==(quota?.row_revision??null)||canonical(quotaWrite.value)!==canonical(attachmentUsageSchema.parse({bytes:bytes-original.expectedBytes,files:files-1})))reject();
}
