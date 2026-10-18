import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readPlanningModules} from '../../../../lib/planning-read';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{return Response.json(await readPlanningModules(env.DB,user.userId),{headers});}
 catch{return Response.json({error:'Planning details changed or are unavailable. Refresh before reviewing another change.'},{status:409,headers});}
}
