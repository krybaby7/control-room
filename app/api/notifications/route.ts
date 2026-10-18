import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readNotifications,reviewResponse} from '../../../lib/reviews/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=await getChatGPTUser();if(!user)return reviewResponse({error:'Sign in to view notifications.'},401);if(!env.DB)return reviewResponse({error:'Notification storage is unavailable.'},503);const url=new URL(request.url);if([...url.searchParams.keys()].some(key=>key!=='after')||url.searchParams.getAll('after').length>1)return reviewResponse({error:'Invalid notification query.'},400);return reviewResponse(await readNotifications(env.DB,user.userId,url.searchParams.get('after')??undefined));}catch{return reviewResponse({error:'Notifications are temporarily unavailable.'},503);}}
