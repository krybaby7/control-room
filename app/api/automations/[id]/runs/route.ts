import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {readAutomationHistory} from '../../../../../lib/automations/history';
import {reviewResponse} from '../../../../../lib/reviews/http';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const user=await getChatGPTUser();if(!user)return reviewResponse({error:'Sign in to view schedule history.'},401);if(!env.DB)return reviewResponse({error:'Schedule history is unavailable.'},503);const url=new URL(request.url);if([...url.searchParams.keys()].some(key=>key!=='after')||url.searchParams.getAll('after').length>1)return reviewResponse({error:'Invalid history query.'},400);const {id}=await params;return reviewResponse(await readAutomationHistory(env.DB,user.userId,id,{after:url.searchParams.get('after')??undefined}));}catch{return reviewResponse({error:'Schedule history is unavailable.'},404);}}
