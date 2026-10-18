import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { readStagedImport,discardStagedImport } from '../../../../../lib/import-staging';
import { readCurrent } from '../../../../../lib/workspace-store';
import { exportWorkspaceBundle } from '../../../../../lib/workspace-export';
import { previewPlanningMerge,type PlanningMergeSelection } from '../../../../../lib/workspace-merge';
import { readOwnerJson } from '../../../../../lib/owner-request';
import { RequestError } from '../../../../../lib/api-guards';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
type Context={params:Promise<{id:string}>};
async function preview(userId:string,id:string,selection?:PlanningMergeSelection){
 const staged=await readStagedImport(env.DB!,userId,id);const current=await readCurrent(env.DB!,userId);const bundle=await exportWorkspaceBundle(env.DB!,userId);
 if(current.revision!==bundle.source.workspaceRevision)throw new Error('Concurrent edit.');
 return {preview:staged.preview(current,bundle.modules),planningBefore:current.workspace,planningIncoming:staged.stage.bundle?.planning??null,...(selection&&staged.stage.bundle?{mergePreview:previewPlanningMerge(current.workspace,staged.stage.bundle.planning,selection)}:{})};
}
export async function GET(request:Request,context:Context){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const id=(await context.params).id;
  if(new URL(request.url).searchParams.get('download')==='1'){const {raw}=await readStagedImport(env.DB,user.userId,id);return new Response(raw as BodyInit,{headers:{...headers,'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="control-room-quarantined-import.json"'}});}
  return Response.json(await preview(user.userId,id),{headers});
 }catch{return Response.json({error:'The import preview is unavailable or stale. Your saved plan has not changed.'},{status:409,headers});}
}
export async function POST(request:Request,context:Context){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const input=await readOwnerJson(request,600_000);if(Object.keys(input).some(key=>!['mode','selection'].includes(key)) || input.mode!=='merge' || !input.selection)throw new RequestError('Explicit merge selection is required.',400);
  return Response.json(await preview(user.userId,(await context.params).id,input.selection as PlanningMergeSelection),{headers});
 }catch(error){return Response.json({error:'This selection cannot be merged safely. Review references, dependencies and capacity.'},{status:error instanceof RequestError?error.status:400,headers});}
}
export async function DELETE(request:Request,context:Context){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const input=await readOwnerJson(request);if(Object.keys(input).length)throw new RequestError('Unsupported discard field.',400);return Response.json({discarded:await discardStagedImport(env.DB,user.userId,(await context.params).id)},{headers});}
 catch(error){return Response.json({error:'The staged import could not be discarded.'},{status:error instanceof RequestError?error.status:400,headers});}
}
