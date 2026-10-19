import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readReview,reviewResponse} from '../../../../lib/reviews/http';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const user=await getChatGPTUser();if(!user)return reviewResponse({error:'Sign in to view reviews.'},401);if(!env.DB)return reviewResponse({error:'Review storage is unavailable.'},503);if(new URL(request.url).search)return reviewResponse({error:'Invalid review query.'},400);const {id}=await params,result=await readReview(env.DB,user.userId,id);return result?reviewResponse(result):reviewResponse({error:'Review is unavailable.'},404);}catch{return reviewResponse({error:'Review is unavailable.'},404);}}
