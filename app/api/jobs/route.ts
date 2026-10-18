import {ownerJobCommand} from './owner-command';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readAgentJobs} from '../../../lib/agents/read-store';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Agent storage is unavailable.'},{status:503,headers});
 const url=new URL(request.url);if([...url.searchParams.keys()].some(key=>!['afterJob','afterEvaluation'].includes(key))||['afterJob','afterEvaluation'].some(key=>url.searchParams.getAll(key).length>1))return Response.json({error:'Invalid owner page.'},{status:400,headers});
 try{return Response.json(await readAgentJobs(env.DB,user.userId,new Date().toISOString(),{afterJob:url.searchParams.get('afterJob')??undefined,afterEvaluation:url.searchParams.get('afterEvaluation')??undefined}),{headers});}
 catch{return Response.json({error:'Agent records are unavailable. Refresh again.'},{status:503,headers});}
}

export async function POST(request:Request){return ownerJobCommand(request,'jobs.create');}
