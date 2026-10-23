import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {ownerReader} from '../../../../lib/workspace-modules';
import {describeHistoryAnalysisScope} from '../../../../lib/history/analysis-journal';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
/** Read-only exact scope preview. Obtaining this hash never authorizes inference. */
export async function GET(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to review history analysis scope.'},{status:401,headers});if(!env.DB)return Response.json({error:'History storage unavailable.'},{status:503,headers});
 const params=new URL(request.url).searchParams,sourceIds=params.getAll('sourceId');if([...params.keys()].some(key=>key!=='sourceId')||sourceIds.length<1||sourceIds.length>100)return Response.json({error:'Select explicit history sources.'},{status:400,headers});
 try{const epoch=(await env.DB.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(user.userId).first<{epoch:number}>())?.epoch??0;const preview=await describeHistoryAnalysisScope(ownerReader(env.DB,user.userId),sourceIds,epoch);return Response.json({privacyScope:'selected_history',sourceIds:preview.sources.map(source=>source.sourceId),policy:preview.policy,policyHash:preview.policyHash,scopeHash:preview.scopeHash,authorized:false},{headers});}catch{return Response.json({error:'Configure an exact enabled policy and review the current selected source scope before authorizing analysis.'},{status:409,headers});}
}
