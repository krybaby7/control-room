import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {handleWorkspaceStream,readOwnerWorkspaceStreamNotice,registeredWorkspaceStreamCapability} from '../../../../lib/workspace-stream';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const user=await getChatGPTUser();
 if(!user)return Response.json({error:'Sign in to refresh your workspace.',diagnostic:'session_expired'},{status:401,headers:{'Cache-Control':'no-store, private'}});
 if(!env.DB)return Response.json({error:'Workspace streaming is unavailable.',diagnostic:'stream_unavailable'},{status:503,headers:{'Cache-Control':'no-store, private'}});
 return handleWorkspaceStream(request,{capability:await registeredWorkspaceStreamCapability(),read:()=>readOwnerWorkspaceStreamNotice(env.DB!,user.userId),authorize:async()=>{const current=await getChatGPTUser();return current?.userId===user.userId;}});
}
