import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readReviews,reviewResponse} from '../../../lib/reviews/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=await getChatGPTUser();if(!user)return reviewResponse({error:'Sign in to view reviews.'},401);if(!env.DB)return reviewResponse({error:'Review storage is unavailable.'},503);if(new URL(request.url).search)return reviewResponse({error:'Invalid review query.'},400);return reviewResponse(await readReviews(env.DB,user.userId,new Date().toISOString()));}catch{return reviewResponse({error:'Reviews are temporarily unavailable.'},503);}}
