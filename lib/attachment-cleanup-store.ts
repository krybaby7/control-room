import {z} from 'zod';
import type {SqlDatabase} from './workspace-store.ts';
import {OWNER_TABLES,ownerReader} from './workspace-modules.ts';
import {readReferenceSnapshot,referenceRegistry,type ReferenceSnapshot} from './workspace-references.ts';
import {listWorkspaceBackups,readWorkspaceBackup} from './workspace-backups.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {evidenceVersionSchema,evidenceDateSchema} from './evidence-validation.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {attachmentStorageKey} from './attachments.ts';
import type {AttachmentCleanupStore,AttachmentCleanupSnapshot,AttachmentDeletionClaim} from './attachment-jobs.ts';
import type {WorkspaceBundle} from './workspace-export.ts';
interface BackupSummary {id:string;sha256:string;status:string;pinned:number;bytes:number;source_revision:number;created_at:string}
interface Fence {storage_key:string;attachment_id:string;namespace:string;token:string;purged_at:string|null}
interface Loaded {snapshot:AttachmentCleanupSnapshot;modules:ReferenceSnapshot;backups:BackupSummary[]}
function backupReferences(bundle:WorkspaceBundle,id:string):boolean{
 if(bundle.attachments.some(entry=>entry.id===id))return true;
 let referenced=false;
 for(const raw of bundle.modules.attachments?.records??[]){const wrapper=raw as {id?:unknown;value?:unknown};const value=wrapper.value;if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'status'))throw new Error('Legacy backup attachment references require review.');const record=attachmentRecordSchema.parse(value);if(wrapper.id!==record.id)throw new Error('Backup attachment identity differs.');if(record.id===id&&record.status!=='deleted')referenced=true;}
 for(const raw of bundle.modules.evidence?.records??[]){const wrapper=raw as {value?:{kind?:unknown;record?:unknown}};const value=wrapper.value;if(value?.kind==='legacy')throw new Error('Legacy backup evidence references require review.');if(value?.kind==='version'){const version=evidenceVersionSchema.parse(value.record);if(version.attachmentIds.includes(id))referenced=true;}}
 return referenced;
}
/** SQL authority is bound to an authenticated owner at construction; no request owner override. */
export function createAttachmentCleanupStore(db:SqlDatabase,userId:string,options:{ownerNamespace:string;now:()=>string}):AttachmentCleanupStore{
 if(typeof userId!=='string'||!userId.trim()||userId.length>256)throw new Error('An authenticated owner is required.');z.string().uuid().parse(options.ownerNamespace);
 const namespace=options.ownerNamespace;
 async function load(id:string):Promise<Loaded|null>{
  z.string().uuid().parse(id);const query=ownerReader(db,userId),modules=await readReferenceSnapshot(query,referenceRegistry),row=await query.get('attachments',id);if(!row)return null;
  const selected=modules.rows.find(item=>item.module==='attachments'&&item.id===id);if(!selected||selected.rowRevision!==row.row_revision||selected.contentHash!==row.content_hash)throw new Error('Attachment changed during reference read.');
  const record=attachmentRecordSchema.parse(JSON.parse(row.payload_json));if(record.id!==id||await contentHash(canonical(record))!==row.content_hash)throw new Error('Attachment metadata identity/hash differs.');
  const persisted=await db.prepare(`SELECT n.user_id FROM workspace_source_namespaces n WHERE n.user_id=? AND (n.blob_namespace=? OR EXISTS(SELECT 1 FROM attachment_blob_namespaces r JOIN attachment_archive_stages s ON s.user_id=r.user_id AND s.namespace=r.namespace JOIN attachment_blob_objects o ON o.user_id=r.user_id AND o.namespace=r.namespace WHERE r.user_id=n.user_id AND r.namespace=? AND r.purpose='archive-stage' AND s.status='committed' AND o.storage_key=? AND o.attachment_id=? AND o.bytes=? AND o.sha256=? AND o.verified_at IS NOT NULL))`).bind(userId,namespace,namespace,record.storageKey,id,record.expectedBytes,record.sha256).first();if(!persisted||record.storageKey!==attachmentStorageKey(namespace,id))throw new Error('Owner attachment namespace differs.');
  const backups=(await db.prepare('SELECT id,sha256,status,pinned,bytes,source_revision,created_at FROM workspace_backups WHERE user_id=? ORDER BY id LIMIT 11').bind(userId).all<BackupSummary>()).results;if(backups.length>10)throw new Error('Backup reference bound exceeded.');
  const manifests=await listWorkspaceBackups(db,userId);if(manifests.length!==backups.length)throw new Error('Backup set changed during reference read.');
  const references=modules.rows.flatMap(item=>item.references.filter(ref=>ref.kind==='attachment'&&ref.id===id).map(()=>`${item.module}:${item.id}`));
  for(const backup of backups){const manifest=manifests.find(item=>item.id===backup.id);if(!manifest||manifest.sha256!==backup.sha256||manifest.status!==backup.status||manifest.bytes!==backup.bytes||Number(manifest.pinned)!==backup.pinned||manifest.sourceRevision!==backup.source_revision||manifest.createdAt!==backup.created_at)throw new Error('Backup metadata changed during reference read.');const verified=await readWorkspaceBackup(db,userId,backup.id);if(!verified||verified.manifest.sha256!==backup.sha256)throw new Error('Backup could not be verified.');if(backupReferences(verified.bundle,id))references.push(`backup:${backup.id}`);}
  const pending=(await db.prepare('SELECT token FROM attachment_upload_attempts WHERE user_id=? AND (storage_key=? OR attachment_id=?) AND settled_at IS NULL ORDER BY token LIMIT 10001').bind(userId,record.storageKey,id).all<{token:string}>()).results;if(pending.length>10000)throw new Error('Pending upload bound exceeded.');for(const attempt of pending)references.push(`upload:${attempt.token}`);
  const fences=(await db.prepare('SELECT storage_key,attachment_id,namespace,token,purged_at FROM attachment_blob_fences WHERE user_id=? AND (storage_key=? OR attachment_id=?) LIMIT 2').bind(userId,record.storageKey,id).all<Fence>()).results;if(fences.length>1)throw new Error('Attachment has conflicting deletion fences.');const fence=fences[0];if(fence&&(fence.storage_key!==record.storageKey||fence.attachment_id!==id||fence.namespace!==namespace))throw new Error('Deletion fence identity differs.');
  const referenceRevision=await contentHash(canonical({modules:modules.rows.map(({module,id,rowRevision,contentHash})=>({module,id,rowRevision,contentHash})),backups,pending}));
  return {modules,backups,snapshot:{record,rowRevision:row.row_revision,ownerNamespace:namespace,references:[...new Set(references)].sort(),referenceRevision,claim:fence?{token:fence.token,attachmentId:id,storageKey:record.storageKey}:null,purged:!!fence?.purged_at}};
 }
 function eligible(loaded:Loaded,claim?:AttachmentDeletionClaim){const s=loaded.snapshot;return !s.references.length&&(s.record.status==='deleted'||s.record.status==='quarantined')&&(!claim||(s.claim?.token===claim.token&&s.claim.attachmentId===claim.attachmentId&&s.claim.storageKey===claim.storageKey));}
 function guards(loaded:Loaded){
  const summary=canonical(loaded.modules.rows.map(({module,id,rowRevision,contentHash})=>({module,id,rowRevision,contentHash})));const backups=canonical(loaded.backups);if(new TextEncoder().encode(summary+backups).length>1_800_000)throw new Error('Cleanup guard exceeds atomic parameter bound.');
  const params:(string|number|null)[]=[summary,backups];const clauses:string[]=[];
  for(const table of OWNER_TABLES){clauses.push(`(SELECT COUNT(*) FROM ${table} WHERE user_id=?)=(SELECT COUNT(*) FROM expected_modules WHERE module='${table}') AND NOT EXISTS(SELECT id,row_revision,content_hash FROM ${table} WHERE user_id=? EXCEPT SELECT id,revision,hash FROM expected_modules WHERE module='${table}')`);params.push(userId,userId);}
  clauses.push('(SELECT COUNT(*) FROM workspace_backups WHERE user_id=?)=(SELECT COUNT(*) FROM expected_backups) AND NOT EXISTS(SELECT id,sha256,status,pinned,bytes,source_revision,created_at FROM workspace_backups WHERE user_id=? EXCEPT SELECT id,sha256,status,pinned,bytes,source_revision,created_at FROM expected_backups)');params.push(userId,userId);
  const s=loaded.snapshot;
  clauses.push(`EXISTS(SELECT 1 FROM attachments a JOIN workspace_source_namespaces n ON n.user_id=a.user_id WHERE a.user_id=? AND a.id=? AND a.row_revision=? AND a.content_hash=? AND (n.blob_namespace=? OR EXISTS(SELECT 1 FROM attachment_blob_namespaces r JOIN attachment_archive_stages s ON s.user_id=r.user_id AND s.namespace=r.namespace JOIN attachment_blob_objects o ON o.user_id=r.user_id AND o.namespace=r.namespace WHERE r.user_id=n.user_id AND r.namespace=? AND r.purpose='archive-stage' AND s.status='committed' AND o.storage_key=? AND o.attachment_id=? AND o.bytes=? AND o.sha256=? AND o.verified_at IS NOT NULL)) AND json_extract(a.payload_json,'$.id')=? AND json_extract(a.payload_json,'$.storageKey')=? AND json_extract(a.payload_json,'$.status') IN ('deleted','quarantined'))`);params.push(userId,s.record.id,s.rowRevision,loaded.modules.rows.find(r=>r.module==='attachments'&&r.id===s.record.id)!.contentHash,namespace,namespace,s.record.storageKey,s.record.id,s.record.expectedBytes,s.record.sha256,s.record.id,s.record.storageKey);
  clauses.push('NOT EXISTS(SELECT 1 FROM attachment_upload_attempts WHERE user_id=? AND (storage_key=? OR attachment_id=?) AND settled_at IS NULL)');params.push(userId,s.record.storageKey,s.record.id);
  return {cte:`WITH expected_modules AS (SELECT json_extract(value,'$.module') module,json_extract(value,'$.id') id,json_extract(value,'$.rowRevision') revision,json_extract(value,'$.contentHash') hash FROM json_each(?)), expected_backups AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.sha256') sha256,json_extract(value,'$.status') status,json_extract(value,'$.pinned') pinned,json_extract(value,'$.bytes') bytes,json_extract(value,'$.source_revision') source_revision,json_extract(value,'$.created_at') created_at FROM json_each(?))`,where:clauses.join(' AND '),params};
 }
 async function authorize(claim:AttachmentDeletionClaim){z.string().uuid().parse(claim.token);const loaded=await load(claim.attachmentId);if(!loaded||!eligible(loaded,claim))return null;return loaded.snapshot;}
 return {
  async read(id){return (await load(id))?.snapshot??null;},
  async claim(input){const loaded=await load(input.attachmentId);if(!loaded||!eligible(loaded)||loaded.snapshot.claim||loaded.snapshot.rowRevision!==input.expectedRowRevision||loaded.snapshot.referenceRevision!==input.referenceRevision||loaded.snapshot.record.storageKey!==input.storageKey)return null;const guard=guards(loaded),token=crypto.randomUUID(),now=options.now();evidenceDateSchema.parse(now);
   const result=await db.prepare(`${guard.cte} INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) SELECT ?,?,?,?,?,?,NULL WHERE ${guard.where} AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences WHERE user_id=? AND (storage_key=? OR attachment_id=?))`).bind(...guard.params.slice(0,2),userId,input.storageKey,input.attachmentId,namespace,token,now,...guard.params.slice(2),userId,input.storageKey,input.attachmentId).run();if(result.meta.changes!==1)return null;return authorize({token,attachmentId:input.attachmentId,storageKey:input.storageKey});
  },
  authorize,
  async complete(claim){
   const loaded=await load(claim.attachmentId);if(!loaded||!eligible(loaded,claim))return false;const guard=guards(loaded),now=options.now();evidenceDateSchema.parse(now);
   // Physical quota is released only here, after the runner confirms object absence.
   // Missing legacy ledger rows stay missing; mismatched authority releases nothing.
   const matchingLedger=`NOT EXISTS(SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND (attachment_id<>? OR namespace<>? OR bytes<>?))`;
   const ledgerParams=[userId,claim.storageKey,claim.attachmentId,namespace,loaded.snapshot.record.expectedBytes];
   const fence=db.prepare(`${guard.cte} UPDATE attachment_blob_fences SET purged_at=COALESCE(purged_at,?) WHERE user_id=? AND storage_key=? AND attachment_id=? AND namespace=? AND token=? AND ${guard.where} AND ${matchingLedger}`).bind(...guard.params.slice(0,2),now,userId,claim.storageKey,claim.attachmentId,namespace,claim.token,...guard.params.slice(2),...ledgerParams);
   const ledger=db.prepare(`${guard.cte} UPDATE attachment_blob_objects SET purged_at=COALESCE(purged_at,?) WHERE user_id=? AND storage_key=? AND attachment_id=? AND namespace=? AND bytes=? AND EXISTS(SELECT 1 FROM attachment_blob_fences WHERE user_id=? AND storage_key=? AND attachment_id=? AND namespace=? AND token=? AND purged_at IS NOT NULL) AND ${guard.where}`).bind(...guard.params.slice(0,2),now,...ledgerParams,userId,claim.storageKey,claim.attachmentId,namespace,claim.token,...guard.params.slice(2));
   const result=await db.batch([fence,ledger]);return result[0]?.meta.changes===1;
  },
 };
}
