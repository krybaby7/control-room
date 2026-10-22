import {jobReadModelSchema,type JobReadModel} from '../agents/read-model.ts';
import {jobDetailSchema,jobEventPageSchema} from '../agents/detail-contracts.ts';
import type {AgentJobEventV1} from '../agents/contracts.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {SessionExpiredError} from '../workspace-client.ts';
import {personalConnectorViewSchema,unconfiguredConnectorSchema,type PersonalConnectorView} from './contracts.ts';
import {ACTIVE_JOB_STATUSES,type FeedKey,type FeedState,type FeedStates,type JobDetailLike,type RuntimeDeviceLike,type SavedReportLike} from './model.ts';
import type {LocalAnalysisReport} from '../../shared/local-analysis.mjs';
import type {GithubAnalysisReport} from '../../shared/github-analysis.mjs';
import {loadSavedLocalAnalyses,SavedLocalAnalysisReadError} from '../local-companion-client.ts';
import {loadSavedGithubAnalyses,SavedGithubAnalysisReadError} from '../github-analysis-client.ts';
import {loadSavedProjectBriefings,SavedBriefingReadError,type SavedProjectBriefing} from '../project-briefing-client.ts';

/** Read-only owner feeds behind the mission-control overview. Every read is bounded in time
 * and bytes, tolerates individual feed failures (the last good value stays, marked stale) and
 * never issues a command. Session expiry surfaces as SessionExpiredError for the shell. */
export const FEED_LIMITS=Object.freeze({deadlineMs:15_000,bodyBytes:2*1024*1024,eventPages:24,fastMs:10_000,slowMs:45_000,slowFeedMs:90_000,failureMs:[30_000,60_000,120_000,300_000]});
export interface FeedSnapshot {
 jobs:JobReadModel|null;jobDetails:Record<string,JobDetailLike>;runtime:{devices:RuntimeDeviceLike[]}|null;connector:PersonalConnectorView|null;
 localReports:SavedReportLike<LocalAnalysisReport>[];cloudReports:SavedReportLike<GithubAnalysisReport>[];briefings:SavedProjectBriefing[];feeds:FeedStates;slowFeedsAt:string|null;
}
export function emptyFeedSnapshot():FeedSnapshot{
 const loading=():FeedState=>({status:'loading',checkedAt:null});
 return {jobs:null,jobDetails:{},runtime:null,connector:null,localReports:[],cloudReports:[],briefings:[],feeds:{jobs:loading(),runtime:loading(),connector:loading(),local:loading(),cloud:loading(),briefings:loading()},slowFeedsAt:null};
}
class FeedUnavailableError extends Error {constructor(message='Feed unavailable.'){super(message);this.name='FeedUnavailableError';}}
class FeedUnconfiguredError extends Error {constructor(){super('Feed not configured.');this.name='FeedUnconfiguredError';}}
export interface FeedReadOptions {fetch?:typeof fetch;signal?:AbortSignal;now?:()=>string;runtimeDecode?:(raw:unknown)=>Promise<{devices:RuntimeDeviceLike[]}>;deadlineMs?:number}
async function readJson(fetcher:typeof fetch,url:string,options:FeedReadOptions):Promise<{status:number;body:unknown}>{
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();
 const timer=setTimeout(()=>controller.abort(),options.deadlineMs??FEED_LIMITS.deadlineMs);
 try{
  const response=await fetcher(url,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
  if(response.status===401)throw new SessionExpiredError();
  const reader=response.body?.getReader();if(!reader)throw new FeedUnavailableError();
  const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>FEED_LIMITS.bodyBytes){await reader.cancel().catch(()=>{});throw new FeedUnavailableError('Feed response exceeds its limit.');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{try{reader.releaseLock();}catch{}}
  let body:unknown;try{body=JSON.parse(text);}catch{throw new FeedUnavailableError('Feed response is not JSON.');}
  return {status:response.status,body};
 }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
async function verifyJobDigests(value:JobReadModel):Promise<JobReadModel>{
 for(const row of value.jobs){
  if(await contentHash(canonical(row.record.spec))!==row.record.specSha256)throw new FeedUnavailableError('Job specification digest differs.');
  if(row.result&&await contentHash(canonical(row.result))!==row.resultHash)throw new FeedUnavailableError('Job result digest differs.');
 }
 return value;
}
export async function readJobsFeed(options:FeedReadOptions={}):Promise<JobReadModel>{
 const {status,body}=await readJson(options.fetch??fetch,'/api/jobs',options);
 if(status!==200)throw new FeedUnavailableError();
 const parsed=jobReadModelSchema.safeParse(body);if(!parsed.success)throw new FeedUnavailableError('Job records are invalid.');
 return verifyJobDigests(parsed.data);
}
/** Detail plus the tail of the event stream for one active attempt, bounded to a page budget. */
export async function readJobDetailFeed(jobId:string,options:FeedReadOptions={}):Promise<JobDetailLike>{
 const fetcher=options.fetch??fetch;
 const {status,body}=await readJson(fetcher,'/api/jobs/'+encodeURIComponent(jobId),options);
 if(status!==200)throw new FeedUnavailableError();
 const detail=jobDetailSchema.safeParse(body);if(!detail.success)throw new FeedUnavailableError('Job detail is invalid.');
 const events:AgentJobEventV1[]=[];let page=detail.data.events,pages=0;
 while(page){
  for(const item of page.items){if(await contentHash(canonical(item.event))!==item.payloadHash)throw new FeedUnavailableError('Job event digest differs.');events.push(item.event);}
  if(page.nextAfterSequence===null||++pages>=FEED_LIMITS.eventPages)break;
  const query=new URLSearchParams({attemptId:page.attemptId,afterSequence:String(page.nextAfterSequence)});
  const next=await readJson(fetcher,'/api/jobs/'+encodeURIComponent(jobId)+'/events?'+query,options);
  if(next.status!==200)break;
  const parsed=jobEventPageSchema.safeParse(next.body);if(!parsed.success||parsed.data.attemptId!==page.attemptId||parsed.data.epoch!==page.epoch)break;
  page=parsed.data;
 }
 return {provider:detail.data.provenance?.provider??null,events};
}
export async function readRuntimeFeed(options:FeedReadOptions={}):Promise<{devices:RuntimeDeviceLike[]}>{
 const {status,body}=await readJson(options.fetch??fetch,'/api/runtime',options);
 if(status!==200)throw new FeedUnavailableError();
 if(options.runtimeDecode)return options.runtimeDecode(body);
 const devices=(body as {devices?:unknown})?.devices;
 if(!Array.isArray(devices))throw new FeedUnavailableError('Runtime records are invalid.');
 return {devices:devices as RuntimeDeviceLike[]};
}
export async function readConnectorFeed(options:FeedReadOptions={}):Promise<PersonalConnectorView>{
 const {status,body}=await readJson(options.fetch??fetch,'/api/personal-repositories',options);
 if(status===503&&unconfiguredConnectorSchema.safeParse(body).success)throw new FeedUnconfiguredError();
 if(status!==200)throw new FeedUnavailableError();
 const parsed=personalConnectorViewSchema.safeParse(body);if(!parsed.success)throw new FeedUnavailableError('Personal PC state is invalid.');
 return parsed.data;
}
function settle<T>(key:FeedKey,outcome:PromiseSettledResult<T>,previous:T,feeds:FeedStates,now:string):T{
 if(outcome.status==='fulfilled'){feeds[key]={status:'ok',checkedAt:now};return outcome.value;}
 const reason=outcome.reason;
 if(reason instanceof SessionExpiredError||(reason instanceof SavedLocalAnalysisReadError||reason instanceof SavedGithubAnalysisReadError||reason instanceof SavedBriefingReadError)&&reason.reason==='session')throw new SessionExpiredError();
 if(reason instanceof FeedUnconfiguredError){feeds[key]={status:'unconfigured',checkedAt:now};return previous;}
 feeds[key]={status:'failed',checkedAt:now,message:reason instanceof Error?reason.message:'Feed unavailable.'};
 return previous;
}
/** One refresh cycle. Fast feeds (jobs, runtime, connector) always read; slow feeds (saved
 * reports) read when `includeSlow` is set. Active jobs also fetch their event tails. */
export async function readFeedSnapshot(previous:FeedSnapshot,options:FeedReadOptions&{includeSlow:boolean}):Promise<FeedSnapshot>{
 const now=(options.now??(()=>new Date().toISOString()))(),feeds:FeedStates={...previous.feeds};
 const [jobs,runtime,connector]=await Promise.allSettled([readJobsFeed(options),readRuntimeFeed(options),readConnectorFeed(options)]);
 const next:FeedSnapshot={...previous,feeds};
 next.jobs=settle('jobs',jobs,previous.jobs,feeds,now);
 next.runtime=settle('runtime',runtime,previous.runtime,feeds,now);
 const connectorValue=settle('connector',connector,previous.connector,feeds,now);
 next.connector=feeds.connector.status==='unconfigured'?null:connectorValue;
 if(options.includeSlow){
  const bounded={fetch:options.fetch,signal:options.signal,timeoutMs:options.deadlineMs??FEED_LIMITS.deadlineMs};
  const [local,cloud,briefings]=await Promise.allSettled([loadSavedLocalAnalyses(bounded),loadSavedGithubAnalyses(bounded),loadSavedProjectBriefings(bounded)]);
  const reportsOf=<R,>(outcome:PromiseSettledResult<{reports:R[]}>):PromiseSettledResult<R[]>=>outcome.status==='fulfilled'?{status:'fulfilled',value:outcome.value.reports}:outcome;
  next.localReports=settle('local',reportsOf(local),previous.localReports,feeds,now);
  next.cloudReports=settle('cloud',reportsOf(cloud),previous.cloudReports,feeds,now);
  next.briefings=settle('briefings',briefings.status==='fulfilled'?{status:'fulfilled',value:briefings.value.briefings}:briefings,previous.briefings,feeds,now);
  next.slowFeedsAt=now;
 }
 if(next.jobs){
  const activeIds=next.jobs.jobs.filter(row=>ACTIVE_JOB_STATUSES.includes(row.status)&&row.attempt&&!row.record.historical).map(row=>row.record.id);
  const details=await Promise.allSettled(activeIds.map(id=>readJobDetailFeed(id,options)));
  const jobDetails:Record<string,JobDetailLike>={};
  details.forEach((outcome,index)=>{const id=activeIds[index];if(outcome.status==='fulfilled')jobDetails[id]=outcome.value;else if(outcome.reason instanceof SessionExpiredError)throw outcome.reason;else if(previous.jobDetails[id])jobDetails[id]=previous.jobDetails[id];});
  next.jobDetails=jobDetails;
 }
 return next;
}

export interface SchedulerDependencies {
 read:(includeSlow:boolean)=>Promise<void>;onError?:(error:unknown)=>void;onExpire?:()=>void;
 now?:()=>number;setTimer?:(callback:()=>void,delayMs:number)=>unknown;clearTimer?:(handle:unknown)=>void;random?:()=>number;
 visible?:boolean;signedIn?:boolean;
}
/** Visibility-aware refresh loop with two paces: fast while an agent is working, slow otherwise.
 * Reads never overlap; failures back off; slow feeds are re-read at most every 90 s. */
export class LiveFeedScheduler {
 private readonly deps:SchedulerDependencies;private running=false;private disposed=false;private visible:boolean;private signedIn:boolean;private pace:'fast'|'slow'='slow';
 private timer:unknown=null;private inFlight:Promise<void>|null=null;private pending=false;private failures=0;private generation=0;private lastSlowAt:number|null=null;private lastReadAt:number|null=null;
 constructor(deps:SchedulerDependencies){this.deps=deps;this.visible=deps.visible??true;this.signedIn=deps.signedIn??true;}
 snapshot(){return {running:this.running,visible:this.visible,signedIn:this.signedIn,pace:this.pace,inFlight:this.inFlight!==null,failures:this.failures,lastReadAt:this.lastReadAt,lastSlowAt:this.lastSlowAt};}
 private eligible(){return this.running&&!this.disposed&&this.visible&&this.signedIn;}
 private clear(){if(this.timer!==null){(this.deps.clearTimer??(handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);this.timer=null;}}
 private schedule(){
  this.clear();if(!this.eligible()||this.inFlight)return;
  const base=this.failures===0?(this.pace==='fast'?FEED_LIMITS.fastMs:FEED_LIMITS.slowMs):FEED_LIMITS.failureMs[Math.min(this.failures-1,FEED_LIMITS.failureMs.length-1)];
  const random=Math.min(1,Math.max(0,(this.deps.random??Math.random)()));
  this.timer=(this.deps.setTimer??((callback,ms)=>setTimeout(callback,ms)))(()=>{this.timer=null;void this.refresh();},Math.round(base*(0.9+random*0.2)));
 }
 start(){if(this.disposed||this.running)return;this.running=true;void this.refresh();}
 stop(){this.running=false;this.pending=false;this.generation++;this.clear();}
 dispose(){this.stop();this.disposed=true;}
 setVisible(value:boolean){const changed=this.visible!==value;this.visible=value;if(!value)this.clear();else if(changed)void this.refresh();}
 setSignedIn(value:boolean){const changed=this.signedIn!==value;this.signedIn=value;if(!value){this.generation++;this.pending=false;this.clear();}else if(changed)void this.refresh();}
 /** Fast pace while any agent is working; switching paces re-schedules the next tick. */
 setPace(value:'fast'|'slow'){if(this.pace===value)return;this.pace=value;if(!this.inFlight)this.schedule();}
 /** Force the slow feeds (saved reports) on the next read, e.g. after the workspace changed. */
 invalidateSlow(){this.lastSlowAt=null;}
 refresh():Promise<void>{
  if(!this.eligible())return Promise.resolve();
  if(this.inFlight){this.pending=true;return this.inFlight;}
  this.clear();this.pending=false;
  const generation=this.generation,now=(this.deps.now??Date.now)(),includeSlow=this.lastSlowAt===null||now-this.lastSlowAt>=FEED_LIMITS.slowFeedMs;
  const flight=Promise.resolve().then(()=>this.deps.read(includeSlow)).then(()=>{
   if(generation!==this.generation||this.disposed)return;
   this.failures=0;this.lastReadAt=(this.deps.now??Date.now)();if(includeSlow)this.lastSlowAt=this.lastReadAt;
  }).catch(error=>{
   if(generation!==this.generation||this.disposed)return;
   if(error instanceof SessionExpiredError){this.setSignedIn(false);this.deps.onExpire?.();return;}
   this.failures++;this.deps.onError?.(error);
  }).finally(()=>{
   this.inFlight=null;
   if(this.pending&&this.eligible()){this.pending=false;void this.refresh();}else this.schedule();
  });
  this.inFlight=flight;return flight;
 }
}
