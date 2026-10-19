import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {previewHistoryUndo} from '../../../../lib/history-undo-store';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'History is unavailable.'},{status:503,headers});
 const params=new URL(request.url).searchParams,eventId=params.get('eventId'),revision=Number(params.get('revision'));
 if([...params.keys()].some(key=>!['eventId','revision'].includes(key)||params.getAll(key).length!==1)||!eventId||eventId.length>128||!Number.isSafeInteger(revision)||revision<1)return Response.json({error:'Choose a history event and current revision.'},{status:400,headers});
 try{return Response.json(await previewHistoryUndo(env.DB,user.userId,eventId,revision,new Date().toISOString()),{headers});}
 catch{return Response.json({error:'This command cannot be undone at the current revision. Refresh history or make an explicit edit.'},{status:409,headers});}
}
