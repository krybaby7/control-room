import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readWorkspaceUsage} from '../../../../lib/workspace-usage';
export const dynamic='force-dynamic';
export async function GET(){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 try{
  const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
  if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
  return Response.json(await readWorkspaceUsage(env.DB,user.userId),{headers});
 }catch{return Response.json({error:'Storage usage could not be loaded.'},{status:503,headers});}
}
