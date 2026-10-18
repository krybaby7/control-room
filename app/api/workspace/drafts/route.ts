import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { listDrafts, saveDraft } from '../../../../lib/drafts';
import { readOwnerJson } from '../../../../lib/owner-request';
import { RequestError } from '../../../../lib/api-guards';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(){
  const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
  if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
  try{return Response.json({drafts:await listDrafts(env.DB,user.userId)},{headers});}catch{return Response.json({error:'Drafts could not be loaded.'},{status:503,headers});}
}
export async function POST(request:Request){
  const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
  if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
  let input:Record<string,unknown>;
  try{input=await readOwnerJson(request,70_000);if(Object.keys(input).some(key=>!['draft','expectedRevision'].includes(key)) || !Number.isSafeInteger(input.expectedRevision))throw new RequestError('Invalid draft envelope.',400);}
  catch(error){return Response.json({error:error instanceof RequestError?error.message:'Invalid draft request.'},{status:error instanceof RequestError?error.status:400,headers});}
  try{const result=await saveDraft(env.DB,user.userId,input.draft,input.expectedRevision as number);return Response.json(result,{status:result.status==='saved'?200:409,headers});}
  catch{return Response.json({error:'The draft could not be saved. Keep this editor open.'},{status:400,headers});}
}
