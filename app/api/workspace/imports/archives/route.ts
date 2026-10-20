import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {listArchiveStages,discardArchiveStage} from '../../../../../lib/attachment-archive-recovery';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to recover staged archives.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Archive recovery is unavailable.'},{status:503,headers});
 const params=new URL(request.url).searchParams;if([...params.keys()].some(key=>!['after','limit'].includes(key)||params.getAll(key).length!==1))return Response.json({error:'Invalid archive page.'},{status:400,headers});
 try{return Response.json(await listArchiveStages(env.DB,user.userId,{...(params.has('after')?{after:params.get('after')!}:{}),...(params.has('limit')?{limit:Number(params.get('limit'))}:{}),now:new Date().toISOString()}),{headers});}catch{return Response.json({error:'Staged archives could not be listed.'},{status:503,headers});}
}
export async function DELETE(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Discard staged archives from this app.'},{status:403,headers});
 if(!env.DB)return Response.json({error:'Archive recovery is unavailable.'},{status:503,headers});
 const params=new URL(request.url).searchParams;if([...params.keys()].some(key=>key!=='id')||params.getAll('id').length!==1)return Response.json({error:'Choose a staged archive.'},{status:400,headers});
 try{const discarded=await discardArchiveStage(env.DB,user.userId,params.get('id')!,new Date().toISOString());return Response.json({discarded,physicalDeletion:false},{status:discarded?200:409,headers});}catch{return Response.json({error:'This archive could not be discarded. Its bytes and quota remain unchanged.'},{status:409,headers});}
}
