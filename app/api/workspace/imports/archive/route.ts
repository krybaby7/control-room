import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {stageAttachmentArchive} from '../../../../../lib/attachment-archive-staging';
import {createR2BlobStore} from '../../../../../lib/attachments';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in before staging an archive.'},{status:401,headers});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Stage an archive from this app.'},{status:403,headers});
 if(!env.DB||!env.BUCKET)return Response.json({error:'Private file storage is not connected.'},{status:503,headers});
 const raw=request.headers.get('x-workspace-revision'),revision=Number(raw);if(!raw||!/^[1-9][0-9]{0,15}$/.test(raw)||!Number.isSafeInteger(revision))return Response.json({error:'A current workspace revision is required.'},{status:400,headers});
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/zip'||!request.body)return Response.json({error:'Choose a native ZIP archive.'},{status:415,headers});
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>220*1024*1024))return Response.json({error:'The native archive exceeds its bounded size.'},{status:413,headers});
 try{const result=await stageAttachmentArchive(env.DB,user.userId,request.body,{store:createR2BlobStore(env.BUCKET),now:()=>new Date().toISOString(),targetRevision:revision});const {id,hash,bytes,diagnostics,expiresAt}=result.stage;return Response.json({id,hash,bytes,diagnostics,expiresAt,archive:result.archive},{headers});}
 catch{return Response.json({error:'The archive could not be fully verified and staged. Active records were not changed. Keep the original archive. Incomplete physical staging remains charged until guarded cleanup; do not repeatedly retry an unconfirmed upload.'},{status:409,headers});}
}
