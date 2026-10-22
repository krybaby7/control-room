import {z} from 'zod';
import type {SqlDatabase} from '../workspace-store.ts';
import {settleUploadBody} from '../upload-body-settlement.ts';
import {PrivateCapacityError} from '../private-capacity.ts';
import {RecoverabilityCapacityError} from '../recoverability-admission.ts';
import type {PrivateHistoryBucket} from './object-store.ts';
import type {AreaAnalysisAuthority} from './analysis-job-store.ts';
import {runAreaAnalysisAttempt,type AreaAnalysisAttemptOptions} from './analysis-dispatch.ts';
import {readHistoryTransportBytes} from './http.ts';
export type HistoryAnalysisRuntime=Pick<AreaAnalysisAttemptOptions,'adapter'|'verifySupport'|'quoteUpperBound'|'consent'|'operationScopeMatches'>;
export interface HistoryAnalysisHttpServices {
 db:SqlDatabase|null;bucket?:PrivateHistoryBucket;now():string;
 /** SERVER ONLY: independent native service identity + private ingress proof.
  * Never derive the owner from body, visitor cookie, a collector enrollment or
  * a broad agent token. Absent verification stays closed. */
 resolveHistoryAnalysisService?:(request:Request,now:string)=>Promise<AreaAnalysisAuthority|null>;
 /** Construction only, no paid calls. Ports come from exact server policy and
  * independent renewal/semantic verification; never deserialize callbacks. */
 createRuntime?:(authority:AreaAnalysisAuthority)=>Promise<HistoryAnalysisRuntime|null>;
}
const inputSchema=z.object({intentId:z.string().min(1).max(128)}).strict();
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 let rejectAbort:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(signal.reason??Error('Analysis request aborted'));signal.addEventListener('abort',rejectAbort,{once:true});if(signal.aborted)rejectAbort();});
 try{return await Promise.race([promise,aborted]);}finally{signal.removeEventListener('abort',rejectAbort);}
}
/** One bounded service request. Only intent identity crosses this wire; response
 * excludes private diagnostics, checkpoint payload, proposal text and provider
 * output. No HTTP dependency can activate inference by default. */
export async function handleHistoryAnalysisRequest(request:Request,services:HistoryAnalysisHttpServices):Promise<Response>{
 const response=(value:unknown,status=200)=>Response.json(value,{status,headers}),signal=AbortSignal.any([request.signal,AbortSignal.timeout(20000)]);
 try{
  if(request.method!=='POST')return response({diagnostic:'method_not_allowed'},405);
  if(request.headers.has('cookie'))return response({diagnostic:'history_analysis_authorization'},401);
  if(!services.db||!services.bucket||!services.resolveHistoryAnalysisService||!services.createRuntime)return response({diagnostic:'history_analysis_unconfigured'},503);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return response({diagnostic:'history_analysis_content_type'},415);
  let raw:unknown;try{const bytes=await abortable(readHistoryTransportBytes(request.body,1024,signal),signal);raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return response({diagnostic:signal.aborted?'history_analysis_deadline':'history_analysis_input'},signal.aborted?408:400);}
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)return response({diagnostic:'history_analysis_input'},400);
  const authority=await abortable(services.resolveHistoryAnalysisService(request,services.now()),signal);if(!authority)return response({diagnostic:'history_analysis_authorization'},401);
  const runtime=await abortable(services.createRuntime(authority),signal);if(!runtime)return response({diagnostic:'history_analysis_unconfigured'},503);
  const result=await abortable(runAreaAnalysisAttempt(services.db,authority.ownerId,parsed.data.intentId,{bucket:services.bucket,authority,now:services.now(),currentTime:()=>services.now(),signal,adapter:runtime.adapter,verifySupport:runtime.verifySupport,quoteUpperBound:runtime.quoteUpperBound,consent:runtime.consent,operationScopeMatches:runtime.operationScopeMatches}),signal);
  const diagnostic=result.status==='not_configured'?'history_analysis_not_configured':result.status==='conflict'?'history_analysis_conflict':result.status==='unavailable'?'history_analysis_unavailable':'history_analysis_processed';
  return response({status:result.status,diagnostic,checkpointState:result.checkpoint?.state??null,requestId:result.requestId&&/^history-analysis-v1:[a-f0-9]{64}$/.test(result.requestId)?result.requestId:null,unknownCount:Math.min(result.unknowns.length,10000),operationProposalCount:Math.min(result.operationProposals.length,100),continuation:result.cursor!==null},result.status==='not_configured'||result.status==='unavailable'?503:result.status==='conflict'?409:200);
 }catch(error){
  if(signal.aborted)return response({diagnostic:'history_analysis_deadline'},408);
  if(error instanceof PrivateCapacityError||error instanceof RecoverabilityCapacityError)return response({diagnostic:'history_analysis_capacity'},429);
  return response({diagnostic:'history_analysis_conflict'},409);
 }finally{if(!request.bodyUsed)await settleUploadBody(request.body);}
}
