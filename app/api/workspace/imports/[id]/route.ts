import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { readStagedImport,discardStagedImport } from '../../../../../lib/import-staging';
import { readCurrent } from '../../../../../lib/workspace-store';
import { exportWorkspaceBundle } from '../../../../../lib/workspace-export';
import { previewPlanningMerge,type PlanningMergeSelection } from '../../../../../lib/workspace-merge';
import { ownerReader } from '../../../../../lib/workspace-modules';
import { ownerAttachmentServices } from '../../../../../lib/attachment-services';
import { prepareNormalizedMerge } from '../../../../../lib/normalized-merge';
import { readOwnerJson } from '../../../../../lib/owner-request';
import { RequestError } from '../../../../../lib/api-guards';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
type Context={params:Promise<{id:string}>};
async function preview(userId:string,id:string,selection?:PlanningMergeSelection){
 const now=new Date().toISOString(),staged=await readStagedImport(env.DB!,userId,id,now);const current=await readCurrent(env.DB!,userId);const bundle=await exportWorkspaceBundle(env.DB!,userId);
 if(current.revision!==bundle.source.workspaceRevision)throw new Error('Concurrent edit.');
 const planningMerge=selection&&staged.stage.bundle?previewPlanningMerge(current.workspace,staged.stage.bundle.planning,selection):null;
 const services=planningMerge?await ownerAttachmentServices(env.DB!,userId,now,env.BUCKET):{};
 const normalized=planningMerge&&staged.stage.bundle?await prepareNormalizedMerge({query:ownerReader(env.DB!,userId),userId,workspaceRevision:current.revision,planningAfter:planningMerge.workspace,bundle:staged.stage.bundle,importHash:staged.stage.hash,importedAt:new Date(staged.stage.createdAt).toISOString(),verifyAttachment:services.verifyAttachment}):null;
 const normalizedRecords=normalized?await Promise.all(normalized.writes.map(async write=>({table:write.table,id:write.id,operation:write.operation,before:write.operation==='insert'?null:JSON.parse((await ownerReader(env.DB!,userId).get(write.table,write.id))!.payload_json),after:write.value}))):[];
 if((await readCurrent(env.DB!,userId)).revision!==current.revision)throw new Error('Concurrent edit.');
 const result={repairReports:(staged.provenance?.reports??[]).map(report=>JSON.parse(report)),...(staged.provenance?{lineage:{parentId:staged.provenance.parentId,parentHash:staged.provenance.parentHash,steps:staged.provenance.reports.length}}:{}),preview:staged.preview(current,bundle.modules),planningBefore:current.workspace,planningIncoming:staged.stage.bundle?.planning??null,...(planningMerge?{mergePreview:planningMerge}:{}),...(normalized?{normalizedMergeReview:normalized.review,normalizedRecords}:{})};
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>8_000_000)throw new Error('Import preview exceeds its bounded response.');
 return result;
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
