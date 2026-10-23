import {validateProjectBriefing,type ProjectBriefing,type BriefingProvider} from '../shared/project-briefing.mjs';
import type {PersonalOwnerAction} from '../shared/personal-repository.mjs';
import {canonical} from './canonical-json.ts';
export function sameProjectBriefing(left:unknown,right:unknown):boolean{return canonical(validateProjectBriefing(left))===canonical(validateProjectBriefing(right));}
export interface SavedProjectBriefing {evidenceId:string;version:number;projectId:string;briefing:ProjectBriefing;recordedAt:string}
export class SavedBriefingReadError extends Error {reason:'timeout'|'session'|'unavailable';constructor(reason:SavedBriefingReadError['reason']){super(reason==='timeout'?'Loading saved briefings took too long. Retry the saved-briefing read; no AI run is needed.':reason==='session'?'Sign in again to load saved briefings.':'Saved briefings could not be loaded. Retry the saved-briefing read; your completed briefing remains available.');this.name='SavedBriefingReadError';this.reason=reason;}}
async function readBoundedJson(fetcher:typeof fetch,url:string,init:RequestInit,signal:AbortSignal,limit:number):Promise<{status:number;body:unknown}>{
 const response=await fetcher(url,{...init,credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 const reader=response.body?.getReader();if(!reader)throw new Error('Empty response.');
 const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit){await reader.cancel().catch(()=>{});throw new Error('Response exceeds its limit.');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{try{reader.releaseLock();}catch{}}
 return {status:response.status,body:text?JSON.parse(text):null};
}
export async function loadSavedProjectBriefings(options:{projectId?:string;signal?:AbortSignal;fetch?:typeof fetch;timeoutMs?:number}={}):Promise<{revision:number;asOf:string;briefings:SavedProjectBriefing[]}>{
 const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs??45000);
 try{
  const {status,body}=await readBoundedJson(options.fetch??fetch,'/api/project-briefings'+(options.projectId?'?projectId='+encodeURIComponent(options.projectId):''),{method:'GET'},controller.signal,1500000);
  if(status===401)throw new SavedBriefingReadError('session');if(status!==200)throw new Error();
  const raw=body as {revision?:unknown;asOf?:unknown;briefings?:unknown};
  if(!raw||!Number.isSafeInteger(raw.revision)||(raw.revision as number)<1||typeof raw.asOf!=='string'||!Number.isFinite(Date.parse(raw.asOf))||!Array.isArray(raw.briefings)||raw.briefings.length>100)throw new Error();
  const identities=new Set<string>();
  const briefings=(raw.briefings as SavedProjectBriefing[]).map(row=>{if(!row||typeof row.evidenceId!=='string'||!row.evidenceId||row.evidenceId.length>128||!Number.isSafeInteger(row.version)||row.version<1||typeof row.projectId!=='string'||!row.projectId||typeof row.recordedAt!=='string'||!Number.isFinite(Date.parse(row.recordedAt))||options.projectId&&row.projectId!==options.projectId||identities.has(row.evidenceId))throw new Error();identities.add(row.evidenceId);return {...row,briefing:validateProjectBriefing(row.briefing)};});
  return {revision:raw.revision as number,asOf:raw.asOf as string,briefings};
 }catch(error){if(error instanceof SavedBriefingReadError)throw error;throw new SavedBriefingReadError(timedOut?'timeout':'unavailable');}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
export class PersonalActionError extends Error {status:number;definitive:boolean;constructor(message:string,status:number,definitive=false){super(message);this.name='PersonalActionError';this.status=status;this.definitive=definitive;}}
/** Owner commands to the personal PC channel. The server pins project and provider on enqueue. */
export async function sendPersonalAction(action:PersonalOwnerAction,options:{fetch?:typeof fetch;signal?:AbortSignal;timeoutMs?:number}={}):Promise<unknown>{
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();const timer=setTimeout(abort,options.timeoutMs??15000);
 try{
  const {status,body}=await readBoundedJson(options.fetch??fetch,'/api/personal-repositories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)},controller.signal,2*1024*1024);
  if(status===401)throw new PersonalActionError('Sign in again to use your PC.',401);
  if(status===503)throw new PersonalActionError('Your PC connection is being set up. Open Control Room on your PC and keep it running.',503);
  if(status<200||status>=300){const failure=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:null;throw new PersonalActionError(typeof failure?.error==='string'?failure.error:'Your PC did not confirm that request. Refresh and try again.',status,failure?.definitiveRejection===true);}
  return body;
 }catch(error){if(error instanceof PersonalActionError)throw error;throw new PersonalActionError('Your PC could not be reached. Check the connection and try again.',0);}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
export function briefingRequest(projectId:string,repositoryKey:string,provider:BriefingProvider):Extract<PersonalOwnerAction,{action:'brief'}>{return {action:'brief',requestId:crypto.randomUUID(),projectId,repositoryKey,provider};}
