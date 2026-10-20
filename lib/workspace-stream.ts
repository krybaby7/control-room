import {canonical,contentHash} from './canonical-json.ts';
import {validateOperationalWatermarks,readOperationalWatermarks} from './operational-watermarks.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {WORKSPACE_STREAM_LIMITS,parseWorkspaceStreamNotice,workspaceStreamCursor,parseWorkspaceStreamCursor,type WorkspaceStreamNotice} from './workspace-stream-codec.ts';
export {WORKSPACE_STREAM_LIMITS,parseWorkspaceStreamNotice,workspaceStreamCursor,parseWorkspaceStreamCursor} from './workspace-stream-codec.ts';
export interface WorkspaceStreamCapability {runtime:'cloudflare-workers';sourceCommit:string;verifiedAt:string;origin:string}
/** Deliberately unregistered until exact-source private-host authentication/streaming acceptance.
 * No request field, environment boolean or browser setting can register this authority. */
export async function registeredWorkspaceStreamCapability():Promise<WorkspaceStreamCapability|null>{return null;}
function shape(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
export async function readOwnerWorkspaceStreamNotice(db:SqlDatabase,ownerId:string):Promise<WorkspaceStreamNotice>{
 if(!ownerId)throw new Error('An authenticated owner is required.');
 for(let attempt=0;attempt<3;attempt++){
  const before=await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(ownerId).first<{revision:number}>();if(!before)throw new Error('Workspace unavailable.');
  const watermarks=await readOperationalWatermarks(db,ownerId);validateOperationalWatermarks(watermarks);const hash=await contentHash(canonical(watermarks));
  const after=await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(ownerId).first<{revision:number}>(),again=await readOperationalWatermarks(db,ownerId);
  if(after?.revision===before.revision&&canonical(watermarks)===canonical(again))return parseWorkspaceStreamNotice({workspaceRevision:before.revision,operationalWatermarksHash:hash});
 }
 throw new Error('Workspace stream boundary changed.');
}
export interface WorkspaceStreamDependencies {
 capability:WorkspaceStreamCapability|null;read:()=>Promise<WorkspaceStreamNotice>;authorize:()=>Promise<boolean>;
 now?:()=>number;setTimer?:(callback:()=>void,ms:number)=>unknown;clearTimer?:(handle:unknown)=>void;
}
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
function unavailable(status=503){return Response.json({error:'Live workspace streaming is unverified; polling remains available.',diagnostic:status===401?'session_expired':'stream_unavailable'},{status,headers});}
async function bounded<T>(request:Request,deps:WorkspaceStreamDependencies,operation:()=>Promise<T>,ms:number):Promise<T>{
 const set=deps.setTimer??((callback,delay)=>setTimeout(callback,delay)),clear=deps.clearTimer??(handle=>clearTimeout(handle as ReturnType<typeof setTimeout>));let timer:unknown=null,abort=()=>{};
 const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error('Workspace stream unavailable.'));timer=set(abort,ms);request.signal.addEventListener('abort',abort,{once:true});});
 try{if(request.signal.aborted)throw new Error('Workspace stream unavailable.');return await Promise.race([Promise.resolve().then(operation),cancelled]);}finally{clear(timer);request.signal.removeEventListener('abort',abort);}
}
export async function handleWorkspaceStream(request:Request,deps:WorkspaceStreamDependencies):Promise<Response>{
 const url=new URL(request.url),site=request.headers.get('sec-fetch-site'),origin=request.headers.get('origin');
 if(request.method!=='GET'||url.search||request.body||site==='cross-site'||origin!==null&&origin!==url.origin||site!=='same-origin'&&origin!==url.origin)return Response.json({error:'Use the same-origin workspace stream.'},{status:403,headers});
 if(request.headers.get('accept')!=='text/event-stream')return Response.json({error:'Use the workspace stream protocol.'},{status:406,headers});
 const requested:string|null=request.headers.get('last-event-id');try{if(requested!==null){parseWorkspaceStreamCursor(requested);}}catch{return Response.json({error:'Invalid stream cursor.'},{status:400,headers});}
 try{if(!await bounded(request,deps,deps.authorize,5000))return unavailable(401);}catch{return unavailable();}
 const now=deps.now??Date.now,cap=deps.capability;
 if(!cap||!shape(cap,['runtime','sourceCommit','verifiedAt','origin'])||cap.runtime!=='cloudflare-workers'||!/^[a-f0-9]{40}$/u.test(cap.sourceCommit)||cap.origin!==url.origin||!Number.isFinite(Date.parse(cap.verifiedAt))||Date.parse(cap.verifiedAt)>now())return unavailable();
 let initial:WorkspaceStreamNotice;try{initial=parseWorkspaceStreamNotice(await bounded(request,deps,deps.read,10000));}catch{return unavailable();}
 if(request.signal.aborted)return unavailable();
 const set=deps.setTimer??((callback,ms)=>setTimeout(callback,ms)),clear=deps.clearTimer??(handle=>clearTimeout(handle as ReturnType<typeof setTimeout>));
 let poll:unknown=null,deadline:unknown=null,closed=false,bytes=0;const encoder=new TextEncoder();let controller:ReadableStreamDefaultController<Uint8Array>;
 const finish=()=>{if(closed)return;closed=true;if(poll!==null)clear(poll);if(deadline!==null)clear(deadline);request.signal.removeEventListener('abort',abort);try{controller.close();}catch{}};
 const abort=()=>finish();
 function emit(event:'ready'|'workspace'|'unavailable'|'session-expired',data:WorkspaceStreamNotice|{reason:string},cursor?:string){if(closed)return;const chunk=encoder.encode((cursor?'id: '+cursor+'\n':'')+'event: '+event+'\n'+'data: '+JSON.stringify(data)+'\n\n');bytes+=chunk.byteLength;if(chunk.byteLength>WORKSPACE_STREAM_LIMITS.eventBytes||bytes>WORKSPACE_STREAM_LIMITS.connectionBytes||(controller.desiredSize??0)<0){finish();return;}try{controller.enqueue(chunk);}catch{finish();}}
 let last=workspaceStreamCursor(initial);
 async function tick(){poll=null;if(closed)return;try{const authorized=await deps.authorize();if(closed)return;if(!authorized){emit('session-expired',{reason:'session_expired'});finish();return;}const notice=parseWorkspaceStreamNotice(await deps.read());if(closed)return;const cursor=workspaceStreamCursor(notice);if(cursor!==last){last=cursor;emit('workspace',notice,cursor);}}catch{emit('unavailable',{reason:'stream_unavailable'});finish();return;}if(!closed)poll=set(()=>{void tick();},WORKSPACE_STREAM_LIMITS.pollMs);}
 const stream=new ReadableStream<Uint8Array>({start(value){controller=value;request.signal.addEventListener('abort',abort,{once:true});deadline=set(finish,WORKSPACE_STREAM_LIMITS.connectionMs);if(request.signal.aborted){finish();return;}emit('ready',initial,last);if(!closed)poll=set(()=>{void tick();},WORKSPACE_STREAM_LIMITS.pollMs);},cancel(){finish();}});
 return new Response(stream,{headers:{...headers,'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'}});
}
