import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const scopes=new AsyncLocalStorage();
const MAX_FRAME=32768,MAX_REPLY=1024,MAX_PENDING=64;
const helperError=reason=>Error('Collector private path helper '+reason);

/** A fixed-script child checks every request anew. No permission results persist. */
export function createWindowsPrivateChecker({signal,timeoutMs=5000,maxPending=MAX_PENDING,spawnHelper=spawn}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>MAX_PENDING)throw helperError('limits invalid');
 let child=null,childClosed=null,failure=null,closing=false,closePromise=null,active=null,sequence=0,buffer=Buffer.alloc(0);
 const queue=[];
 const finish=(request,error)=>{clearTimeout(request.timer);request.signal?.removeEventListener('abort',request.abort);if(error)request.reject(error);else request.resolve();};
 function fail(reason){
  if(failure)return;
  failure=helperError(reason);
  if(active){finish(active,failure);active=null;}
  for(const request of queue.splice(0))finish(request,failure);
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 }
 const abort=()=>fail('aborted');
 signal?.addEventListener('abort',abort,{once:true});
 if(signal?.aborted)abort();
 function receive(bytes){
  if(failure)return;
  if(!active){fail('sent unsolicited output');return;}
  if(buffer.length+bytes.length>MAX_REPLY){fail('reply too large');return;}
  buffer=Buffer.concat([buffer,bytes]);
  const newline=buffer.indexOf(10);if(newline<0)return;
  if(newline!==buffer.length-1){fail('sent extra output');return;}
  let line,reply;
  try{line=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,newline));if(line.endsWith('\r'))line=line.slice(0,-1);reply=JSON.parse(line);}catch{fail('reply malformed');return;}
  if(!reply||Object.keys(reply).sort().join(',')!=='id,ok'||reply.id!==active.id||typeof reply.ok!=='boolean'||line!==JSON.stringify({id:active.id,ok:reply.ok})){fail('reply differs');return;}
  if(!reply.ok){fail('denied private path');return;}
  const request=active;active=null;buffer=Buffer.alloc(0);finish(request);queueMicrotask(pump);
 }
 function start(){
  const root=process.env.SystemRoot??'C:\\Windows';
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='psmodulepath')),PSModulePath:join(root,'System32','WindowsPowerShell','v1.0','Modules')};
  try{child=spawnHelper(join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../windows/private-path-helper.ps1',import.meta.url))],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env});}
  catch{fail('could not start');return;}
  // Register completion before any awaited event, including failed spawn.
  childClosed=new Promise(resolveClose=>{child.once('close',(code,exitSignal)=>{if(!closing||code!==0||exitSignal||active||queue.length)fail('closed unexpectedly');resolveClose();});});
  child.once('error',()=>fail('could not start'));
  child.stdin.on('error',()=>{if(!closing)fail('input unavailable');});
  child.stdout.on('data',receive);
  child.stderr.on('data',()=>fail('reported a failure'));
 }
 function pump(){
  if(failure||closing||active||queue.length===0)return;
  if(!child)start();if(failure)return;
  active=queue.shift();
  child.stdin.write(active.frame,error=>{if(error)fail('input unavailable');});
 }
 return {
  check(path,{signal:requestSignal=signal}={}){
   if(failure)return Promise.reject(failure);
   if(closing)return Promise.reject(helperError('closed'));
   if(requestSignal?.aborted){fail('aborted');return Promise.reject(failure);}
   if(typeof path!=='string'||!path||path.length>4096||path.includes('\0'))return Promise.reject(helperError('path invalid'));
   if(queue.length+(active?1:0)>=maxPending)return Promise.reject(helperError('queue full'));
   if(!Number.isSafeInteger(sequence+1))return Promise.reject(helperError('identity exhausted'));
   const id=++sequence,frame=JSON.stringify({id,path:resolve(path)})+'\n';
   if(Buffer.byteLength(frame)>MAX_FRAME)return Promise.reject(helperError('request too large'));
   return new Promise((resolveCheck,reject)=>{
    const request={id,frame,signal:requestSignal,resolve:resolveCheck,reject,abort:()=>fail('aborted'),timer:null};
    // Waiting for another request consumes the same finite deadline.
    request.timer=setTimeout(()=>fail('timed out'),timeoutMs);
    requestSignal?.addEventListener('abort',request.abort,{once:true});
    queue.push(request);pump();
   });
  },
  close(){
   if(closePromise)return closePromise;
   closing=true;signal?.removeEventListener('abort',abort);
   if(active||queue.length)fail('closed with pending checks');
   closePromise=(async()=>{
    if(!child){if(failure)throw failure;return;}
    let killTimer;
    try{
     if(child.exitCode===null&&child.signalCode===null){child.stdin.end();killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);}
     await childClosed;
     if(failure)throw failure;
    }finally{clearTimeout(killTimer);child.stdout.removeListener('data',receive);buffer=Buffer.alloc(0);}
   })();return closePromise;
  }
 };
}

/** Ordinary nested guards reuse their owner; independent collector runs do not. */
export async function withWindowsPrivateChecks(operation,{signal,checkerFactory=createWindowsPrivateChecker,independent=false}={}){
 const parent=independent?null:scopes.getStore();
 if(parent){
  if(parent.owner.closed)throw helperError('scope closed');
  const effectiveSignal=signal&&parent.signal&&signal!==parent.signal?AbortSignal.any([signal,parent.signal]):signal??parent.signal;
  effectiveSignal?.throwIfAborted();return await scopes.run({...parent,signal:effectiveSignal},operation);
 }
 const owner={checker:null,closed:false,checkerFactory};
 let operationFailed=false;
 try{signal?.throwIfAborted();return await scopes.run({owner,signal},operation);}
 catch(error){operationFailed=true;throw error;}
 finally{owner.closed=true;try{await owner.checker?.close();}catch(error){if(!operationFailed)throw error;}}
}
export async function checkWindowsPrivatePath(path){
 if(process.platform!=='win32')return;
 const scope=scopes.getStore();
 if(!scope)return await withWindowsPrivateChecks(()=>checkWindowsPrivatePath(path));
 if(scope.owner.closed)throw helperError('scope closed');
 if(scope.signal?.aborted)throw helperError('aborted');
 scope.owner.checker??=scope.owner.checkerFactory({signal:scope.signal});
 await scope.owner.checker.check(path,{signal:scope.signal});
}
