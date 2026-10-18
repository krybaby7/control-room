import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readChanges} from '../../../lib/changes-feed';
import {reviewResponse} from '../../../lib/reviews/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=await getChatGPTUser();if(!user)return reviewResponse({error:'Sign in to view changes.'},401);if(!env.DB)return reviewResponse({error:'Change storage is unavailable.'},503);const url=new URL(request.url);if([...url.searchParams.keys()].some(key=>key!=='cursor')||url.searchParams.getAll('cursor').length>1)return reviewResponse({error:'Invalid change query.'},400);return reviewResponse(await readChanges(env.DB,user.userId,{cursor:url.searchParams.get('cursor')??undefined},new Date().toISOString()));}catch{return reviewResponse({error:'Changes are temporarily unavailable.'},503);}}
