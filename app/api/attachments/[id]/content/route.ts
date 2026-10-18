import {resolveAttachmentNamespace} from '../../../../../lib/attachment-namespace-access';
import {canonical,contentHash} from '../../../../../lib/canonical-json';
import {attachmentDownloadHeaders,AttachmentPolicyError} from '../../../../../lib/attachment-policy';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {ownerReader} from '../../../../../lib/workspace-modules';
import {attachmentRecordSchema} from '../../../../../lib/evidence-module';
import {createR2BlobStore,readReadyAttachment,stageAttachmentUpload,AttachmentReplayMismatchError} from '../../../../../lib/attachments';
import {beginUpload,finishUpload,isBlobFenced} from '../../../../../lib/attachment-upload-fences';
import {getWorkspaceNamespaces} from '../../../../../lib/workspace-namespaces';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to download attachments.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Attachment storage is unavailable.'},{status:503,headers});
 const {id}=await params;if(!id||id.length>128)return new Response(null,{status:404,headers});
 try{
  const row=await ownerReader(env.DB,user.userId).get('attachments',id),namespaces=await getWorkspaceNamespaces(env.DB,user.userId);
  if(!row||!namespaces)return new Response(null,{status:404,headers});
  const payload=JSON.parse(row.payload_json);if(await contentHash(canonical(payload))!==row.content_hash)throw new Error('Attachment metadata differs.');const record=attachmentRecordSchema.parse(payload);if(record.id!==id||record.status!=='ready')return new Response(null,{status:404,headers});
  if(await isBlobFenced(env.DB,user.userId,{attachmentId:id,storageKey:record.storageKey}))return new Response(null,{status:404,headers});
  const store=createR2BlobStore(env.BUCKET);if(!store.available)return Response.json({error:'Private attachment storage is not connected.'},{status:503,headers});
  const ownerNamespace=await resolveAttachmentNamespace(env.DB,user.userId,record);if(!ownerNamespace)return new Response(null,{status:404,headers});
  const verified=await readReadyAttachment(user.userId,record,store,{ownerNamespace});
  return new Response(verified.bytes as BodyInit,{headers:attachmentDownloadHeaders(record.filename,record.mimeType,new URL(request.url).searchParams.get('inline')==='1')});
 }catch{return Response.json({error:'This attachment is unavailable.'},{status:503,headers});}
}

/** Transport stages immutable bytes only. Finalization remains a separate receipted owner command. */
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again before uploading.'},{status:401,headers});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Upload from this app.'},{status:403,headers});
 if(!env.DB)return Response.json({error:'Attachment storage is unavailable.'},{status:503,headers});
 const {id}=await params;if(!id||id.length>128)return new Response(null,{status:404,headers});
 try{
  const row=await ownerReader(env.DB,user.userId).get('attachments',id),namespaces=await getWorkspaceNamespaces(env.DB,user.userId);
  if(!row||!namespaces)return new Response(null,{status:404,headers});
  const payload=JSON.parse(row.payload_json);if(await contentHash(canonical(payload))!==row.content_hash)throw new Error('Attachment metadata differs.');const record=attachmentRecordSchema.parse(payload);if(record.id!==id)return new Response(null,{status:404,headers});
  if(record.status!=='reserved')return Response.json({error:'This reservation is no longer open.'},{status:409,headers});
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!==record.mimeType||!request.body)return Response.json({error:'Use the reserved file type and original body.'},{status:415,headers});
  const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==record.expectedBytes))return Response.json({error:'File length differs from its reservation.'},{status:413,headers});
  const store=createR2BlobStore(env.BUCKET);if(!store.available)return Response.json({error:'Private attachment storage is not connected.'},{status:503,headers});
  const token=await beginUpload(env.DB,user.userId,{record,rowRevision:row.row_revision,now:new Date().toISOString(),ownerNamespace:namespaces.blobNamespace});
  if(!token)return Response.json({error:'The reservation changed or is fenced. Refresh before uploading.'},{status:409,headers});
  let writing=false,settled=false;
  const guardedStore={...store,async put(...args:Parameters<typeof store.put>){writing=true;const result=await store.put(...args);settled=true;return result;}};
  let result;
  try{result=await stageAttachmentUpload(user.userId,record,request.body,guardedStore,{ownerNamespace:namespaces.blobNamespace});}
  finally{if(!writing||settled)await finishUpload(env.DB,user.userId,{token,now:new Date().toISOString(),definitivelySettled:true});}
  // Ambiguous storage writes intentionally retain their nonexpiring pending token.

  if(result.status==='staged')return Response.json({status:'staged',id,replayed:result.replayed,bytes:result.blob.bytes,sha256:result.blob.sha256,finalized:false},{headers});
  return Response.json({status:result.status,error:result.status==='quarantined'?'Content verification failed. The attachment has not been finalized.':'Private storage verification is unavailable. Keep the original file and retry.',finalized:false},{status:result.status==='quarantined'?422:503,headers});
 }catch(error){if(error instanceof AttachmentReplayMismatchError)return Response.json({error:'A different file body already occupies this reservation. Retry the original file.'},{status:409,headers});if(error instanceof AttachmentPolicyError)return Response.json({error:error.message},{status:error.code==='file_too_large'?413:error.code==='upload_timeout'?408:422,headers});return Response.json({error:'Upload could not be confirmed. Retry the original file before finalizing.'},{status:503,headers});}
}
