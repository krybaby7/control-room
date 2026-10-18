import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { readOwnerJson } from '../../../../lib/owner-request';
import { RequestError } from '../../../../lib/api-guards';
import { issueMutationId } from '../../../../lib/idempotency-retention';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const input=await readOwnerJson(request,1024);if(Object.keys(input).length)throw new RequestError('Unsupported submission request.',400);return Response.json({mutationId:await issueMutationId(env.DB,user.userId,new Date().toISOString())},{headers});}
 catch(error){return Response.json({error:'A submission identity could not be issued.'},{status:error instanceof RequestError?error.status:503,headers});}
}
