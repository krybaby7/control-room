import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { readOwnerBytes } from '../../../../lib/owner-request';
import { RequestError } from '../../../../lib/api-guards';
import { stageImport,IMPORT_STAGING_LIMITS } from '../../../../lib/import-staging';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const raw=await readOwnerBytes(request,IMPORT_STAGING_LIMITS.bytes);const stage=await stageImport(env.DB,user.userId,raw);return Response.json({id:stage.id,hash:stage.hash,bytes:stage.bytes,diagnostics:stage.diagnostics,expiresAt:stage.expiresAt},{headers});}
 catch(error){return Response.json({error:error instanceof RequestError?error.message:'The import could not be staged. No planning records changed.'},{status:error instanceof RequestError?error.status:503,headers});}
}
