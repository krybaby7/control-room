import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readReviews,reviewResponse} from '../../../lib/reviews/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=await getChatGPTUser();if(!user)return reviewResponse({error:'Sign in to view schedules.'},401);if(!env.DB)return reviewResponse({error:'Schedule storage is unavailable.'},503);if(new URL(request.url).search)return reviewResponse({error:'Invalid schedule query.'},400);const value=await readReviews(env.DB,user.userId,new Date().toISOString());return reviewResponse({revision:value.revision,asOf:value.asOf,schedules:value.schedules,unattended:value.unattended});}catch{return reviewResponse({error:'Schedules are temporarily unavailable.'},503);}}
