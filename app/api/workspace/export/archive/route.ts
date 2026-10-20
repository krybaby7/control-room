import {resolveAttachmentNamespace} from '../../../../../lib/attachment-namespace-access';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {exportWorkspaceBundle} from '../../../../../lib/workspace-export';
import {attachmentRecordSchema} from '../../../../../lib/evidence-module';
import {writeAttachmentArchive} from '../../../../../lib/attachment-archive-export';
import {getWorkspaceNamespaces} from '../../../../../lib/workspace-namespaces';
import {createR2BlobStore,readReadyAttachment} from '../../../../../lib/attachments';
import {isBlobFenced} from '../../../../../lib/attachment-upload-fences';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to export your workspace.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Export is unavailable.'},{status:503,headers});
 if(new URL(request.url).search)return Response.json({error:'This export takes no selection parameters.'},{status:400,headers});
 try{
  const db=env.DB,bundle=await exportWorkspaceBundle(db,user.userId),namespaces=await getWorkspaceNamespaces(db,user.userId);
  const ready=(bundle.modules.attachments?.records??[]).flatMap(raw=>{const value=(raw as {value:unknown}).value,parsed=attachmentRecordSchema.safeParse(value);if(parsed.success&&parsed.data.status==='ready')return [parsed.data];return [];});
  const store=createR2BlobStore(env.BUCKET);if(ready.length&&(!namespaces||!store.available))return Response.json({error:'Private file storage is unavailable. Use the clearly labelled metadata-only export instead.'},{status:503,headers});
  const records=new Map(ready.map(record=>[record.id,record]));
  const stream=writeAttachmentArchive(bundle,ready,async id=>{const record=records.get(id);if(!record||!namespaces||await isBlobFenced(db,user.userId,{attachmentId:id,storageKey:record.storageKey}))throw new Error('Frozen attachment is unavailable.');const ownerNamespace=await resolveAttachmentNamespace(db,user.userId,record);if(!ownerNamespace)throw new Error('Frozen attachment namespace is unavailable.');return (await readReadyAttachment(user.userId,record,store,{ownerNamespace})).bytes;});
  return new Response(stream,{headers:{...headers,'Content-Type':'application/zip','Content-Disposition':'attachment; filename="control-room-files.zip"'}});
 }catch{return Response.json({error:'The full archive could not be prepared. No workspace records were changed.'},{status:503,headers});}
}
