import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {getChatGPTUser} from '../../chatgpt-auth';
import {baselineHeaders as headers,BaselineHttpError,baselineHistoryQuery,readBaselineHistory} from '../../../lib/baselines/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});if(!env.DB)return Response.json({error:'Baseline storage is unavailable.'},{status:503,headers});try{return Response.json(await readBaselineHistory(env.DB,user.userId,baselineHistoryQuery(new URL(request.url)),new Date().toISOString()),{headers});}catch(error){return Response.json({error:error instanceof BaselineHttpError?error.message:error instanceof z.ZodError?'Invalid baseline query.':'Baseline history is unavailable.'},{status:error instanceof BaselineHttpError?error.status:error instanceof z.ZodError?400:503,headers});}}
