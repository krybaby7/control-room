import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {handleOwnerJobRead} from '../../../../../lib/agents/owner-read-http';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){const user=await getChatGPTUser();return handleOwnerJobRead(request,user?.userId??null,env.DB??null,(await params).jobId,new Date().toISOString(),true);}
