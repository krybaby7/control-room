import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readRuntime} from '../../../lib/runtime/store';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Runtime storage is unavailable.'},{status:503,headers});
 try{return Response.json(await readRuntime(env.DB,user.userId,new Date().toISOString()),{headers});}
 catch{return Response.json({error:'Runtime state is unavailable.'},{status:503,headers});}
}
