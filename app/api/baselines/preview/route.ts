import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {baselineHeaders as headers,BaselineHttpError,readBaselinePreviewInput} from '../../../../lib/baselines/http';
import {previewBaselineRevision} from '../../../../lib/baselines/preview';
export const dynamic='force-dynamic';
export async function POST(request:Request){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});if(!env.DB)return Response.json({error:'Baseline storage is unavailable.'},{status:503,headers});try{if(new URL(request.url).search)throw new BaselineHttpError('Invalid preview query.',400);const input=await readBaselinePreviewInput(request),preview=await previewBaselineRevision(env.DB,user.userId,input,new Date().toISOString());return Response.json(preview,{headers});}catch(error){return Response.json({error:error instanceof BaselineHttpError?error.message:error instanceof z.ZodError?'Invalid baseline selection.':'Baseline preview is unavailable. Refresh and try again.'},{status:error instanceof BaselineHttpError?error.status:error instanceof z.ZodError?400:503,headers});}}
