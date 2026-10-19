import {z} from 'zod';
import {AgentResultVerificationError} from './result-verifier.ts';
import {ownerAgentContext} from './context.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {DEVICE_LIMITS,unavailablePrivateIngress,type DevicePrincipal,type PrivateIngressVerifier} from '../devices/contracts.ts';
import {authenticateDevice,deviceAuthorityGuard} from '../devices/auth.ts';
import {RecoverabilityCapacityError} from '../recoverability-admission.ts';
import {agentCapabilitySchema,agentIdSchema,agentJobEventSchema,agentJobResultSchema} from './contracts.ts';
import {evaluationUploadSchema,commitEvaluationSummary} from './evaluations-store.ts';
type AgentStoreOptions=Parameters<typeof import('./store.ts').claimAgentJob>[3];
export type AgentHttpAction='capabilities'|'claim'|'renew'|'events'|'complete'|'reconcile'|'evaluations';
export interface AgentHttpDependencies {
 db:SqlDatabase|null;ingress?:PrivateIngressVerifier;now?:()=>string;bodyTimeoutMs?:number;
 context?:AgentStoreOptions['context'];verifyResult?:AgentStoreOptions['verifyResult'];verifyNoLaunch?:AgentStoreOptions['verifyNoLaunch'];
 /** Closed server fixture/adapter seam, never taken from request JSON. */
 operations?:Partial<Record<Exclude<AgentHttpAction,'evaluations'>,(principal:DevicePrincipal,value:unknown,now:string)=>Promise<unknown>>>;
}
export const agentHttpHeaders={'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff'};
const secret=z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),leaseToken=z.string().regex(/^[a-f0-9]{64}$/),revision=z.number().int().positive().safe();
export const agentCapabilityUploadSchema=z.object({capability:agentCapabilitySchema,expectedOperationalRevision:revision.nullable()}).strict();
const claimSchema=z.object({jobId:agentIdSchema,journalNonce:secret}).strict(),leaseSchema=z.object({attemptId:agentIdSchema,leaseToken}).strict();
const eventsSchema=leaseSchema.extend({events:z.array(agentJobEventSchema).min(1).max(50)}).strict(),completeSchema=leaseSchema.extend({result:agentJobResultSchema}).strict();
const reconcileSchema=z.object({attemptId:agentIdSchema,journalNonce:secret,proof:z.enum(['no-launch','exited']),events:z.array(agentJobEventSchema).min(1).max(50).optional(),result:agentJobResultSchema.optional()}).strict();
class BodyFailure extends Error{readonly status:number;constructor(status:number){super('Agent request body rejected.');this.status=status;}}
const actions=new Set<AgentHttpAction>(['capabilities','claim','renew','events','complete','reconcile','evaluations']);
function rejected(status:number,code='agent_request_rejected'){return Response.json({error:status===408?'Agent request timed out.':'Agent request was rejected.',code},{status,headers:agentHttpHeaders});}
async function cancelWithin(body:ReadableStream<Uint8Array>|null):Promise<void>{
 if(!body||body.locked)return;let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([body.cancel().catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,100);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
}
async function readBody(request:Request,timeoutMs:number):Promise<unknown>{
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new BodyFailure(415);
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^\d{1,12}$/.test(declared)||Number(declared)>65536))throw new BodyFailure(413);
 const reader=request.body?.getReader();if(!reader)throw new BodyFailure(400);let timer:ReturnType<typeof setTimeout>|undefined;
 const read=async()=>{const chunks:Uint8Array[]=[];let length=0;for(;;){const part=await reader.read();if(part.done)break;if(!(part.value instanceof Uint8Array))throw new BodyFailure(400);length+=part.value.byteLength;if(length>65536)throw new BodyFailure(413);chunks.push(part.value.slice());}const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new BodyFailure(400);}};
 try{return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BodyFailure(408)),timeoutMs);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);let settle:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([reader.cancel().catch(()=>{}),new Promise<void>(resolve=>{settle=setTimeout(resolve,100);})]);}finally{if(settle!==undefined)clearTimeout(settle);try{reader.releaseLock();}catch{/* Bounded cancellation never waits on an uncooperative stream. */}}}
}
function parseAction(action:AgentHttpAction,value:unknown):unknown{
 if(action==='capabilities')return agentCapabilityUploadSchema.parse(value);if(action==='claim')return claimSchema.parse(value);if(action==='renew')return leaseSchema.parse(value);if(action==='events')return eventsSchema.parse(value);if(action==='complete')return completeSchema.parse(value);if(action==='reconcile')return reconcileSchema.parse(value);return evaluationUploadSchema.parse(value);
}
/** Separate private ingress and mapped device credentials are required before any
 * body read. Scope sets are exact: telemetry is never execution/evaluation access.
 * This adapter never launches a provider, creates an approval, or supplies a
 * no-launch/physical-artifact verifier from a request.
 */
export async function handleAgentHttp(action:AgentHttpAction,request:Request,deps:AgentHttpDependencies):Promise<Response>{
 try{
  if(request.method!=='POST')return new Response(null,{status:405,headers:{...agentHttpHeaders,Allow:'POST'}});
  if(!actions.has(action))return rejected(400);if(request.headers.has('Cookie'))return rejected(403);
  if(new URL(request.url).search)return rejected(400);if(!deps.db)return rejected(503,'agent_unavailable');
  const now=deps.now??(()=>new Date().toISOString()),before=evidenceDateSchema.parse(now()),ingress=deps.ingress??unavailablePrivateIngress;
  let verified:{serviceIdentity:string}|null;try{verified=await ingress.verify(request);}catch{return rejected(401,'agent_unauthorized');}
  if(!verified||typeof verified.serviceIdentity!=='string'||!verified.serviceIdentity||verified.serviceIdentity.length>256)return rejected(401,'agent_unauthorized');
  const principal=await authenticateDevice(request,action==='evaluations'?'evaluations:write':'jobs:poll',deps.db,{async verify(){return verified;}},before);
  if(!principal)return rejected(401,'agent_unauthorized');if(action!=='evaluations'&&!principal.scopes.includes('jobs:report'))return rejected(403,'agent_scope_mismatch');
  const timeout=deps.bodyTimeoutMs??DEVICE_LIMITS.requestMs;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>15000)throw new Error('Invalid server body deadline.');
  const value=parseAction(action,await readBody(request,timeout)),fresh=evidenceDateSchema.parse(now());
  if(Date.parse(fresh)<Date.parse(before)||!await deviceAuthorityGuard(deps.db,principal,fresh))return rejected(401,'agent_unauthorized');
  if(action==='capabilities'&&agentCapabilityUploadSchema.parse(value).capability.deviceId!==principal.deviceId)return rejected(403,'agent_scope_mismatch');
  let result:unknown;
  if(action==='evaluations')result=await commitEvaluationSummary(deps.db,principal,evaluationUploadSchema.parse(value),fresh);
  else if(deps.operations?.[action])result=await deps.operations[action]!(principal,value,fresh);
  else{
   const store=await import('./store.ts');
   if(action==='capabilities')result=await store.reportAgentCapability(deps.db,principal,agentCapabilityUploadSchema.parse(value),{now:fresh});
   else{
    const context=deps.context??ownerAgentContext(deps.db,principal.ownerId,fresh);
    const options={now:fresh,context,verifyResult:deps.verifyResult,verifyNoLaunch:deps.verifyNoLaunch};
    if(action==='claim')result=await store.claimAgentJob(deps.db,principal,claimSchema.parse(value),options);
    else if(action==='renew')result=await store.renewAgentLease(deps.db,principal,leaseSchema.parse(value),options);
    else if(action==='events')result=await store.reportAgentEvents(deps.db,principal,eventsSchema.parse(value),options);
    else if(action==='complete')result=await store.completeAgentAttempt(deps.db,principal,completeSchema.parse(value),options);
    else result=await store.reconcileAgentAttempt(deps.db,principal,reconcileSchema.parse(value),options);
   }
  }
  const conflict=result!==null&&typeof result==='object'&&'status'in result&&result.status==='conflict';
  return Response.json(result,{status:conflict?409:200,headers:agentHttpHeaders});
 }catch(error){
  if(error instanceof AgentResultVerificationError)return rejected(409,error.code);
  if(error instanceof BodyFailure)return rejected(error.status);if(error instanceof z.ZodError||error instanceof SyntaxError)return rejected(400);
  if(error instanceof RecoverabilityCapacityError)return rejected(409,'recovery_capacity');
  const status=error&&typeof error==='object'&&'status'in error?error.status:null;
  if(typeof status==='number'&&Number.isInteger(status)&&[400,401,403,404,408,409,413,415,429].includes(status))return rejected(status,status===409?'agent_conflict':'agent_request_rejected');
  return rejected(503,'agent_unavailable');
 }finally{if(!request.bodyUsed)await cancelWithin(request.body);}
}
export function createAgentHttpHandlers(deps:AgentHttpDependencies){return Object.fromEntries([...actions].map(action=>[action,(request:Request)=>handleAgentHttp(action,request,deps)])) as Record<AgentHttpAction,(request:Request)=>Promise<Response>>;}
