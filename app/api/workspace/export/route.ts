import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { exportWorkspaceBundle } from '../../../../lib/workspace-export';
export const dynamic='force-dynamic';
export async function GET(){
  const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
  const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
  if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
  try{return Response.json(await exportWorkspaceBundle(env.DB,user.userId),{headers});}
  catch{return Response.json({error:'A complete export is not available yet. Your records have not changed.'},{status:503,headers});}
}
