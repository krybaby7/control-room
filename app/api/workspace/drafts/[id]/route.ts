import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { deleteDraft } from '../../../../../lib/drafts';
import { readOwnerJson } from '../../../../../lib/owner-request';
import { RequestError } from '../../../../../lib/api-guards';
export const dynamic='force-dynamic';
export async function DELETE(request:Request,context:{params:Promise<{id:string}>}){
  const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
  const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
  if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
  try{const input=await readOwnerJson(request);if(Object.keys(input).some(key=>key!=='revision') || !Number.isSafeInteger(input.revision) || (input.revision as number)<1)throw new RequestError('Invalid draft revision.',400);
    const deleted=await deleteDraft(env.DB,user.userId,(await context.params).id,input.revision as number);return Response.json({deleted},{status:deleted?200:409,headers});
  }catch(error){return Response.json({error:'The draft could not be discarded.'},{status:error instanceof RequestError?error.status:400,headers});}
}
