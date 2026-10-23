import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readProjectBriefings} from '../../../lib/project-briefing-store';
import {evidenceIdSchema} from '../../../lib/evidence-validation';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to view project briefings.'},{status:401,headers});
 const url=new URL(request.url),projectId=url.searchParams.get('projectId')??undefined;
 if([...url.searchParams.keys()].some(key=>key!=='projectId')||url.searchParams.getAll('projectId').length>1||(projectId!==undefined&&!evidenceIdSchema.safeParse(projectId).success))return Response.json({error:'Invalid project filter.'},{status:400,headers});
 if(!env.DB)return Response.json({error:'Project briefings are temporarily unavailable.'},{status:503,headers});
 try{return Response.json(await readProjectBriefings(env.DB,user.userId,projectId),{headers});}catch{return Response.json({error:'Project briefings could not be loaded.'},{status:503,headers});}
}
