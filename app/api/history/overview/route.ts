import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readHistoryOverview} from '../../../../lib/history/overview';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to view retained history.'},{status:401,headers});if(!env.DB)return Response.json({error:'History storage is unavailable.'},{status:503,headers});try{return Response.json(await readHistoryOverview(env.DB,user.userId,new Date().toISOString()),{headers});}catch{return Response.json({error:'History could not be read coherently. Retry while retaining your current view.'},{status:503,headers});}}
