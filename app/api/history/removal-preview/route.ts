import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {ownerReader} from '../../../../lib/workspace-modules';
import {previewHistoryRemoval} from '../../../../lib/history/removal';
import {readHistoryRecord} from '../../../../lib/history/store';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to preview removal.'},{status:401,headers});if(!env.DB)return Response.json({error:'History storage unavailable.'},{status:503,headers});const params=new URL(request.url).searchParams,sourceId=params.get('sourceId');if(!sourceId||sourceId.length>128||[...params.keys()].some(k=>k!=='sourceId')||params.getAll('sourceId').length!==1)return Response.json({error:'Select one source.'},{status:400,headers});try{const source=await readHistoryRecord(env.DB,user.userId,'source',sourceId);if(!source)return Response.json({error:'Source unavailable.'},{status:404,headers});const {digest,counts,retention}=await previewHistoryRemoval(ownerReader(env.DB,user.userId),sourceId);return Response.json({digest,counts,retention},{headers});}catch{return Response.json({error:'Removal impact could not be read. No history was removed.'},{status:503,headers});}}
