import {z} from 'zod';
import type {SqlDatabase} from '../workspace-store.ts';
import {RequestError} from '../api-guards.ts';
import type {HeartbeatEnvelopeV1,HeartbeatReceipt} from '../runtime/contracts.ts';
import {parseHeartbeatEnvelope,heartbeatReceiptSchema} from '../runtime/validation.ts';
import {DEVICE_LIMITS,type DevicePrincipal,type PrivateIngressVerifier} from './contracts.ts';
import {deviceSessionInputSchema,deviceLiveWindowInputSchema,bridgeVersionSchema} from './validation.ts';
import {authenticateDevice,admitDeviceRequest} from './auth.ts';
import {DeviceStoreError,redeemDeviceEnrollment,registerDeviceSession,issueDeviceLiveWindow,rotateDeviceCredential} from './store.ts';
export interface DeviceHttpDependencies {db:SqlDatabase|null;ingress:PrivateIngressVerifier;now:()=>string;ingest?:(db:SqlDatabase,principal:DevicePrincipal,value:HeartbeatEnvelopeV1,now:string)=>Promise<HeartbeatReceipt>;afterHeartbeat?:(db:SqlDatabase,principal:DevicePrincipal,now:string)=>Promise<unknown>;bodyTimeoutMs?:number}
export type DeviceHttpAction='enroll'|'session'|'live-window'|'heartbeat'|'rotate';
export const deviceHttpHeaders={'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff'};
class BodyFailure extends Error {readonly status:number;constructor(status:number){super('Device request body was rejected.');this.status=status;}}
async function cancelWithin(body:ReadableStream<Uint8Array>|null):Promise<void>{if(!body||body.locked)return;let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([body.cancel().catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,100);})]);}finally{if(timer!==undefined)clearTimeout(timer);}}
/** Ingress and credential authentication must complete before this reader is called. */
async function readBody(request:Request,timeoutMs:number):Promise<Uint8Array>{
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new BodyFailure(415);
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^\d{1,12}$/.test(declared)||Number(declared)>DEVICE_LIMITS.requestBytes))throw new BodyFailure(413);
 const reader=request.body?.getReader();if(!reader)throw new BodyFailure(400);let timer:ReturnType<typeof setTimeout>|undefined;
 const read=async()=>{const chunks:Uint8Array[]=[];let length=0;for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>DEVICE_LIMITS.requestBytes)throw new BodyFailure(413);chunks.push(part.value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;};
 try{return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BodyFailure(408)),timeoutMs);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);let settle:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([reader.cancel().catch(()=>{}),new Promise<void>(resolve=>{settle=setTimeout(resolve,100);})]);}finally{if(settle!==undefined)clearTimeout(settle);try{reader.releaseLock();}catch{/* A nonconforming stream may retain a pending read; no reader is awaited indefinitely. */}}}
}
const enrollment=z.object({secret:z.string().regex(/^[A-Za-z0-9_-]{32,512}$/),bridgeVersion:bridgeVersionSchema}).strict(),empty=z.object({}).strict();
function rejected(status:number){return Response.json({error:status===408?'Device request timed out.':'Device request was rejected.',code:status===409?'device_conflict':status===429?'device_rate_limited':status===401?'device_unauthorized':'device_request_rejected'},{status,headers:deviceHttpHeaders});}
/** Factory dependencies are server-owned. The production ingress default is unavailable.
 * No request owner, browser session, platform Authorization substitution, shell or provider action is accepted. */
export async function handleDeviceHttp(action:DeviceHttpAction,request:Request,deps:DeviceHttpDependencies):Promise<Response>{
 try{
  if(request.method!=='POST')return new Response(null,{status:405,headers:{...deviceHttpHeaders,Allow:'POST'}});
  if(request.headers.has('Cookie'))return rejected(403);
  if(new URL(request.url).search)return rejected(400);
  if(!deps.db)return rejected(503);
  let verified:{serviceIdentity:string}|null;try{verified=await deps.ingress.verify(request);}catch{return rejected(401);}
  if(!verified||typeof verified.serviceIdentity!=='string'||!verified.serviceIdentity||verified.serviceIdentity.length>256)return rejected(401);
  let now=deps.now();if(!await admitDeviceRequest(deps.db,'device-http:'+verified.serviceIdentity,now,600))return rejected(429);let principal:DevicePrincipal|null=null;
  if(action!=='enroll'){principal=await authenticateDevice(request,'telemetry:write',deps.db,{async verify(){return verified;}},now);if(!principal)return rejected(401);}
  const timeout=deps.bodyTimeoutMs??DEVICE_LIMITS.requestMs;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>DEVICE_LIMITS.requestMs)throw new Error('Invalid server body deadline.');
  const bytes=await readBody(request,timeout);now=deps.now();let raw:unknown;
  try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return rejected(400);}
  if(action==='enroll'){const result=await redeemDeviceEnrollment(deps.db,enrollment.parse(raw),{now,verifiedIngress:verified});return Response.json(result,{status:201,headers:deviceHttpHeaders});}
  if(action==='session')return Response.json(await registerDeviceSession(deps.db,principal!,deviceSessionInputSchema.parse(raw),now),{headers:deviceHttpHeaders});
  if(action==='live-window')return Response.json(await issueDeviceLiveWindow(deps.db,principal!,deviceLiveWindowInputSchema.parse(raw),now),{headers:deviceHttpHeaders});
  if(action==='rotate'){empty.parse(raw);return Response.json(await rotateDeviceCredential(deps.db,principal!,now),{status:201,headers:deviceHttpHeaders});}
  if(action==='heartbeat'){const value=parseHeartbeatEnvelope(bytes);if(value.heartbeat.deviceId!==principal!.deviceId)return rejected(403);if(!deps.ingest)return rejected(503);const receipt=heartbeatReceiptSchema.parse(await deps.ingest(deps.db,principal!,value,now));if(deps.afterHeartbeat)try{await deps.afterHeartbeat(deps.db,principal!,now);}catch{/* Cleanup is bounded maintenance; its failure cannot change a committed heartbeat receipt. */}return Response.json(receipt,{headers:deviceHttpHeaders});}
  return rejected(400);
 }catch(error){if(error instanceof BodyFailure)return rejected(error.status);if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof TypeError)return rejected(400);if(error instanceof DeviceStoreError||error instanceof RequestError)return rejected(error.status);return rejected(503);}
 finally{if(!request.bodyUsed)await cancelWithin(request.body);}
}
export function createDeviceHttpHandlers(deps:DeviceHttpDependencies){return {enroll:(request:Request)=>handleDeviceHttp('enroll',request,deps),session:(request:Request)=>handleDeviceHttp('session',request,deps),liveWindow:(request:Request)=>handleDeviceHttp('live-window',request,deps),heartbeat:(request:Request)=>handleDeviceHttp('heartbeat',request,deps),rotate:(request:Request)=>handleDeviceHttp('rotate',request,deps)};}
