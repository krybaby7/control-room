import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../../chatgpt-auth';
import {readOwnerJson} from '../../../../../../lib/owner-request';
import {RequestError} from '../../../../../../lib/api-guards';
import {readStagedImport,stageImport} from '../../../../../../lib/import-staging';
import {repairPlanningImport,type PlanningRepairOperation} from '../../../../../../lib/import-repair';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
const invalid=(status=400)=>Response.json({error:'This staged import cannot be repaired with that operation. No saved planning records changed.'},{status,headers});
export async function POST(request:Request,context:{params:Promise<{id:string}>}){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return invalid(503);
 let input:Record<string,unknown>;
 try{input=await readOwnerJson(request,65536);if(Object.keys(input).length!==1||!Object.hasOwn(input,'operation'))return invalid();}catch(error){return invalid(error instanceof RequestError?error.status:400);}
 const now=new Date().toISOString();
 let parent;
 try{parent=await readStagedImport(env.DB,user.userId,(await context.params).id,now);}catch(error){return invalid(error instanceof Error&&error.message==='Import not found or expired.'?400:503);}
 let repaired;
 try{repaired=await repairPlanningImport(parent.raw,input.operation as PlanningRepairOperation);if(repaired.report.sourceHash!==parent.stage.hash)return invalid();}catch{return invalid();}
 const reports=[...(parent.provenance?.reports??[]),JSON.stringify(repaired.report)];
 // Validate the bounded lineage in staging before any write; over-limit repairs remain quarantined.
 if(reports.length>8||new TextEncoder().encode(JSON.stringify(reports)).byteLength>1_500_000)return invalid();
 try{const stageNow=new Date().toISOString();const stage=await stageImport(env.DB,user.userId,repaired.raw,stageNow,{parentId:parent.stage.id,parentHash:parent.stage.hash,reports});const recovered=await readStagedImport(env.DB,user.userId,stage.id,stageNow);return Response.json({id:stage.id,hash:stage.hash,bytes:stage.bytes,diagnostics:stage.diagnostics,expiresAt:stage.expiresAt,repairReports:recovered.provenance!.reports},{headers});}catch{return invalid(503);}
}
