import {WORKSPACE_STREAM_LIMITS,parseWorkspaceStreamNotice,parseWorkspaceStreamCursor,workspaceStreamCursor,type WorkspaceStreamNotice} from './workspace-stream-codec.ts';
export type WorkspaceStreamStatus='polling-unverified'|'connecting'|'streaming'|'polling-fallback'|'paused'|'expired';
type StreamEvent={type:'ready'|'workspace';notice:WorkspaceStreamNotice;cursor:string}|{type:'unavailable'|'session-expired'};
function error():never{throw new Error('Workspace stream unavailable.');}
/** Strict bounded protocol reader; notices carry no planning/editor content. */
export async function consumeWorkspaceStream(response:Response,signal:AbortSignal,onEvent:(event:StreamEvent)=>void):Promise<void>{
 if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/event-stream'||!response.body)error();
 const declared=response.headers.get('content-length');if(declared!==null&&(!/^[0-9]{1,8}$/u.test(declared)||Number(declared)>WORKSPACE_STREAM_LIMITS.connectionBytes))error();
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,pending='',fields:string[]=[];
 const abort=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 const dispatch=()=>{if(!fields.length)return;const seen=new Set<string>(),data:Record<string,string>={};for(const line of fields){const match=/^(id|event|data): (.*)$/u.exec(line);if(!match||seen.has(match[1]))error();seen.add(match[1]);data[match[1]]=match[2];}fields=[];if(!data.event||!data.data)error();let body:unknown;try{body=JSON.parse(data.data);}catch{error();}
  if(data.event==='ready'||data.event==='workspace'){const notice=parseWorkspaceStreamNotice(body);parseWorkspaceStreamCursor(data.id);if(data.id!==workspaceStreamCursor(notice))error();onEvent({type:data.event,notice,cursor:data.id});}
  else if(data.event==='unavailable'||data.event==='session-expired'){if(data.id!==undefined||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||(body as {reason?:unknown}).reason!==(data.event==='unavailable'?'stream_unavailable':'session_expired'))error();onEvent({type:data.event});}
  else error();
 };
 try{if(signal.aborted)error();for(;;){const {done,value}=await reader.read();if(signal.aborted)return;if(done)break;if(!(value instanceof Uint8Array))error();size+=value.byteLength;if(size>WORKSPACE_STREAM_LIMITS.connectionBytes)error();pending+=decoder.decode(value,{stream:true});if(pending.length>WORKSPACE_STREAM_LIMITS.eventBytes)error();let lineEnd;while((lineEnd=pending.indexOf('\n'))!==-1){const line=pending.slice(0,lineEnd);pending=pending.slice(lineEnd+1);if(line.endsWith('\r')||line.length>WORKSPACE_STREAM_LIMITS.eventBytes)error();if(line==='')dispatch();else if(!line.startsWith(':')){fields.push(line);if(fields.join('\n').length>WORKSPACE_STREAM_LIMITS.eventBytes)error();}}}
  pending+=decoder.decode();if(pending||fields.length)error();
 }finally{signal.removeEventListener('abort',abort);reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export interface WorkspaceStreamClientDependencies {
 /** Explicit client transport preference, never server capability authority. Default false. */
 enabled?:boolean;fetch?:typeof fetch;onNotice:(notice:WorkspaceStreamNotice)=>void;onExpire:()=>void;onStatus?:(status:WorkspaceStreamStatus)=>void;
 now?:()=>number;setTimer?:(callback:()=>void,ms:number)=>unknown;clearTimer?:(handle:unknown)=>void;
}
export class WorkspaceStreamClient{
 private deps:WorkspaceStreamClientDependencies;private running=false;private disposed=false;private signedIn=true;private visible=true;private busy=false;private generation=0;private abort:AbortController|null=null;private timer:unknown=null;private cursor:string|null=null;private pending:WorkspaceStreamNotice|null=null;private failures=0;private status:WorkspaceStreamStatus='polling-unverified';
 constructor(deps:WorkspaceStreamClientDependencies){this.deps=deps;}
 snapshot(){return {status:this.status,cursor:this.cursor,running:this.running,busy:this.busy};}
 private setStatus(value:WorkspaceStreamStatus){if(this.status!==value){this.status=value;this.deps.onStatus?.(value);}}
 private clear(){if(this.timer!==null){(this.deps.clearTimer??(handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);this.timer=null;}this.abort?.abort();this.abort=null;}
 private eligible(){return this.running&&!this.disposed&&this.signedIn&&this.visible&&this.deps.enabled===true;}
 start(){if(this.disposed||this.running)return;this.running=true;this.failures=0;if(this.deps.enabled!==true){this.setStatus('polling-unverified');return;}void this.connect();}
 stop(){this.running=false;this.generation++;this.pending=null;this.clear();this.setStatus('paused');}
 dispose(){this.stop();this.disposed=true;this.cursor=null;}
 setSignedIn(value:boolean){if(this.signedIn===value)return;this.signedIn=value;this.generation++;this.clear();this.pending=null;if(!value){this.cursor=null;this.setStatus('expired');}else if(this.eligible())void this.connect();}
 setVisible(value:boolean){if(this.visible===value)return;this.visible=value;this.generation++;this.clear();if(!value)this.setStatus('paused');else if(this.eligible())void this.connect();}
 setBusy(value:boolean){this.busy=value;if(!value&&this.pending&&this.eligible()){const notice=this.pending;this.pending=null;this.deps.onNotice(notice);}}
 private async connect(){
  if(!this.eligible()||this.abort)return;const generation=++this.generation,controller=new AbortController();this.abort=controller;this.setStatus('connecting');const started=(this.deps.now??Date.now)(),set=this.deps.setTimer??((callback,ms)=>setTimeout(callback,ms)),clear=this.deps.clearTimer??(handle=>clearTimeout(handle as ReturnType<typeof setTimeout>));let ready=false;
  let deadline:unknown=null,aborted=()=>{};const timedOut=new Promise<never>((_resolve,reject)=>{aborted=()=>reject(new Error('Workspace stream unavailable.'));controller.signal.addEventListener('abort',aborted,{once:true});deadline=set(()=>{controller.abort();},25000);});
  try{const headers:Record<string,string>={Accept:'text/event-stream'};if(this.cursor)headers['Last-Event-ID']=this.cursor;
   const response=await Promise.race([(this.deps.fetch??fetch)('/api/workspace/events',{method:'GET',headers,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal}),timedOut]);
   if(generation!==this.generation||!this.eligible()){response.body?.cancel().catch(()=>{});return;}
   if(response.status===401||response.status===403){response.body?.cancel().catch(()=>{});this.setSignedIn(false);this.deps.onExpire();return;}if(!response.ok){response.body?.cancel().catch(()=>{});error();}
   await Promise.race([consumeWorkspaceStream(response,controller.signal,event=>{if(generation!==this.generation||!this.eligible())return;if(event.type==='session-expired'){this.setSignedIn(false);this.deps.onExpire();return;}if(event.type==='unavailable')error();ready=true;this.setStatus('streaming');const previous=this.cursor;if(previous&&event.notice.workspaceRevision<parseWorkspaceStreamCursor(previous).workspaceRevision)error();this.cursor=event.cursor;if(previous!==event.cursor){if(this.busy)this.pending=event.notice;else this.deps.onNotice(event.notice);}}),timedOut]);
   if(generation!==this.generation||!this.eligible())return;
   if(!ready||controller.signal.aborted)error();const duration=(this.deps.now??Date.now)()-started;if(duration<15000){this.failures++;if(this.failures>=3)error();}else this.failures=0;
   this.timer=set(()=>{this.timer=null;void this.connect();},1000);
  }catch{if(generation===this.generation&&this.eligible()){this.running=false;this.pending=null;this.setStatus('polling-fallback');}}
  finally{clear(deadline);controller.signal.removeEventListener('abort',aborted);if(this.abort===controller)this.abort=null;controller.abort();}
 }
}
