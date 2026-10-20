import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readHistoryEntry} from '../../../../lib/history-entry';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'History is unavailable.'},{status:503,headers});
 const params=new URL(request.url).searchParams;if([...params.keys()].some(key=>key!=='id')||params.getAll('id').length!==1)return Response.json({entry:null},{status:404,headers});
 try{const entry=await readHistoryEntry(env.DB,user.userId,params.get('id')!);return Response.json({entry},{status:entry?200:404,headers});}catch{return Response.json({error:'This history entry is unavailable.'},{status:503,headers});}
}
