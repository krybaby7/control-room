import {resolveAttachmentNamespace} from './attachment-namespace-access.ts';
import type {SqlDatabase} from './workspace-store.ts';
import type {OwnerCommandServices} from './workspace-context.ts';
import {isBlobFenced} from './attachment-upload-fences.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {createR2BlobStore,readReadyAttachment,type AttachmentBucket} from './attachments.ts';
/** Authentication supplies owner. Missing storage remains unavailable; no namespace or binding is invented here. */
export async function ownerAttachmentServices(db:SqlDatabase,userId:string,now:string,bucket?:AttachmentBucket):Promise<OwnerCommandServices>{
 const namespaces=await getWorkspaceNamespaces(db,userId);if(!namespaces)return {};
 const store=createR2BlobStore(bucket);
 return {...(bucket?{fileBackupServices:{bucket,attachmentBucket:bucket}}:{}),attachmentAccess:{ownerNamespace:namespaces.blobNamespace,store,resolveNamespace:record=>resolveAttachmentNamespace(db,userId,record),hasPhysicalIdentity:async record=>!!await db.prepare('SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND attachment_id=? LIMIT 1').bind(userId,record.id).first()},verifyAttachment:async record=>{
  const ownerNamespace=await resolveAttachmentNamespace(db,userId,record);if(!ownerNamespace)return null;
  if(!store.available||await isBlobFenced(db,userId,{attachmentId:record.id,storageKey:record.storageKey}))return null;try{const proof=await readReadyAttachment(userId,record,store,{ownerNamespace,now});
  return {record,verifiedSha256:proof.metadata.sha256,verifiedBytes:proof.bytes.length,signatureVerified:true};}catch{return null;}
 }};
}
