import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readOwnerJson} from '../../../../lib/owner-request';
import {RequestError} from '../../../../lib/api-guards';
import {readCurrent} from '../../../../lib/workspace-store';
import {ownerPrepareContext} from '../../../../lib/workspace-context';
import {ownerAttachmentServices} from '../../../../lib/attachment-services';
import {previewOwnerAcceptance,type OwnerAcceptancePreviewInput} from '../../../../lib/acceptance-preview';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Evidence storage is unavailable.'},{status:503,headers});
 try{
  const body=await readOwnerJson(request,65536);if(Object.keys(body).some(key=>!['revision','input'].includes(key))||!Number.isSafeInteger(body.revision)||!body.input)throw new RequestError('A current revision and assessment selection are required.',400);
  const now=new Date().toISOString(),before=await readCurrent(env.DB,user.userId,now);
  if(body.revision!==before.revision)return Response.json({error:'The workspace changed. Refresh before reviewing.'},{status:409,headers});
  const context=ownerPrepareContext(env.DB,user.userId,before,{type:'acceptance.preview'},now,await ownerAttachmentServices(env.DB,user.userId,now,env.BUCKET));
  const preview=await previewOwnerAcceptance(context,body.input as OwnerAcceptancePreviewInput);
  if((await readCurrent(env.DB,user.userId,now)).revision!==before.revision)return Response.json({error:'The workspace changed during review. Refresh before reviewing.'},{status:409,headers});
  return Response.json(preview,{headers});
 }catch(error){return Response.json({error:error instanceof RequestError?error.message:error instanceof z.ZodError?'Invalid assessment selection.':'Assessment preview is unavailable. Refresh and try again.'},{status:error instanceof RequestError?error.status:error instanceof z.ZodError?400:503,headers});}
}
