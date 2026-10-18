import type {SqlDatabase} from './workspace-store.ts';
import type {AttachmentRecord} from './evidence-contract.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {attachmentStorageKey} from './attachments.ts';
/** Server-only binding: portable storage keys never establish namespace ownership. */
export async function resolveAttachmentNamespace(db:SqlDatabase,userId:string,record:AttachmentRecord):Promise<string|null>{
 if(!userId)throw new Error('An authenticated owner is required.');
 const base=await getWorkspaceNamespaces(db,userId);if(!base)return null;
 if(record.storageKey===attachmentStorageKey(base.blobNamespace,record.id))return base.blobNamespace;
 const row=await db.prepare(`SELECT n.namespace FROM attachment_blob_namespaces n JOIN attachment_archive_stages s ON s.user_id=n.user_id AND s.namespace=n.namespace JOIN attachment_blob_objects o ON o.user_id=n.user_id AND o.namespace=n.namespace WHERE n.user_id=? AND n.purpose='archive-stage' AND s.status='committed' AND o.storage_key=? AND o.attachment_id=? AND o.bytes=? AND o.sha256=? AND o.verified_at IS NOT NULL AND o.purged_at IS NULL LIMIT 2`).bind(userId,record.storageKey,record.id,record.expectedBytes,record.sha256).all<{namespace:string}>();
 if(row.results.length!==1)return null;const namespace=row.results[0].namespace;
 return record.storageKey===attachmentStorageKey(namespace,record.id)?namespace:null;
}
