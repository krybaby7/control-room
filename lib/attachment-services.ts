import type {SqlDatabase} from './workspace-store.ts';
import type {OwnerCommandServices} from './workspace-context.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {createR2BlobStore,readReadyAttachment,type AttachmentBucket} from './attachments.ts';
/** Authentication supplies owner. Missing storage remains unavailable; no namespace or binding is invented here. */
export async function ownerAttachmentServices(db:SqlDatabase,userId:string,now:string,bucket?:AttachmentBucket):Promise<OwnerCommandServices>{
 const namespaces=await getWorkspaceNamespaces(db,userId);if(!namespaces)return {};
 const store=createR2BlobStore(bucket);
 return {attachmentAccess:{ownerNamespace:namespaces.blobNamespace,store},verifyAttachment:async record=>{
  if(!store.available)return null;const proof=await readReadyAttachment(userId,record,store,{ownerNamespace:namespaces.blobNamespace,now});
  return {record,verifiedSha256:proof.metadata.sha256,verifiedBytes:proof.bytes.length,signatureVerified:true};
 }};
}
