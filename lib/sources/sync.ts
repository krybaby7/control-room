import {z} from 'zod';
import type {IntegrationJobClaim} from '../background/job-contract.ts';
import type {SourcePageCommitResult} from './store.ts';
import type {SourceRunFinishResult} from './run-store.ts';
import {SOURCE_LIMITS,SourceReadError,type SourceAdapter,type SourcePage,type SourceProposal,type SourceRunHistory,type SourceTarget,type SourceFailure} from './contracts.ts';
import {sourceTargetSchema,sourcePageSchema,sourceProposalSchema,sourceFailureSchema} from './validation.ts';
import {evidenceDateSchema,evidenceIdSchema} from '../evidence-validation.ts';
import {assertProposalFieldsAllowed} from './proposals.ts';
import {canonical,contentHash} from '../canonical-json.ts';
const positive=z.number().int().positive().safe();
const claimSchema=z.object({ownerId:z.string().min(1).max(256),intentId:evidenceIdSchema,sourceId:evidenceIdSchema,configurationHash:z.string().regex(/^[a-f0-9]{64}$/),executionEpoch:z.number().int().nonnegative().safe(),operationalRevision:positive,jobRevision:positive,connectionId:evidenceIdSchema,accessMode:z.enum(['manual','interactive','unattended']),principalRef:z.string().min(1).max(256),token:z.string().uuid(),expiresAt:evidenceDateSchema,attempt:positive,cursor:z.string().max(SOURCE_LIMITS.cursorBytes).nullable(),etag:z.string().max(2000).nullable()}).strict();
export interface SourceSyncInput {claim:IntegrationJobClaim;target:SourceTarget;startedAt:string}
export interface SourceSyncDependencies {
 adapter:SourceAdapter;
 isCurrent:(claim:IntegrationJobClaim,now:string)=>Promise<boolean>;
 commitPage:(claim:IntegrationJobClaim,input:{page:SourcePage;proposals?:SourceProposal[];now:string})=>Promise<SourcePageCommitResult>;
 finishRun:(claim:IntegrationJobClaim,input:{run:SourceRunHistory;now:string})=>Promise<SourceRunFinishResult>;
 now:()=>string;
 clock?:()=>number;
 signal?:AbortSignal;
 timers?:{set:(callback:()=>void,milliseconds:number)=>unknown;clear:(handle:unknown)=>void};
 /** Pure server-selected proposal preparation, never owner acceptance. */
 buildProposals?:(page:SourcePage,claim:IntegrationJobClaim)=>Promise<SourceProposal[]>;
}
export type SourceSyncReason='complete'|'page_budget'|'observation_budget'|'time_budget'|'cancelled'|'provider_failure'|'no_progress'|'claim_changed'|'storage_uncertain';
interface Summary {runId:string;claim:IntegrationJobClaim;pages:number;observations:number;reason:SourceSyncReason}
export type SourceSyncResult=
 |(Summary&{status:'completed'|'partial'|'failed'|'cancelled';run:SourceRunHistory;finish:Exclude<SourceRunFinishResult,{status:'conflict'}>})
 |(Summary&{status:'conflict';run:SourceRunHistory|null})
 |(Summary&{status:'uncertain';phase:'claim-check'|'page-commit'|'run-finish';run:SourceRunHistory|null;pendingPage?:{page:SourcePage;proposals:SourceProposal[];now:string}});
/** Execute one already-authorized private intent. No claims or new jobs are minted.
 * Pages commit before the next read. Storage uncertainty returns the exact pending
 * payload/terminal record for receipt reconciliation, never an invented failure.
 * Timers bound provider/proposal calls; an in-flight storage CAS is awaited to its
 * definitive result even if the provider budget expires during that transaction. */
export async function runSourceSync(input:SourceSyncInput,deps:SourceSyncDependencies):Promise<SourceSyncResult>{
 let claim=claimSchema.parse(structuredClone(input.claim));const target=sourceTargetSchema.parse(structuredClone(input.target));evidenceDateSchema.parse(input.startedAt);
 if(target.id!==claim.sourceId||target.connectionId!==claim.connectionId||target.archivedAt!==null||claim.accessMode==='manual'&&!['document','conversation_export'].includes(target.kind))throw new SourceReadError('invalid_content','Claim and selected source differ.');
 const clock=deps.clock??(()=>performance.now()),start=clock();if(!Number.isFinite(start))throw new Error('A monotonic source clock is required.');
 const runId=`source-run-${await contentHash(canonical([claim.ownerId,claim.intentId,claim.token,claim.attempt,input.startedAt]))}`;
 const controller=new AbortController();let deadlineExpired=false,externalCancelled=deps.signal?.aborted??false;
 const cancel=()=>{externalCancelled=true;controller.abort();};if(externalCancelled)controller.abort();deps.signal?.addEventListener('abort',cancel,{once:true});
 const timers=deps.timers??{set:(callback:()=>void,ms:number)=>setTimeout(callback,ms),clear:(handle:unknown)=>clearTimeout(handle as ReturnType<typeof setTimeout>)};
 const timer=timers.set(()=>{deadlineExpired=true;controller.abort();},Math.max(0,SOURCE_LIMITS.runProviderMs-(clock()-start)));
 let pages=0,observations=0,changed=false,sourceRevision:string|null=null,reason:SourceSyncReason='complete',run:SourceRunHistory|null=null;
 const visited=new Set<string>(claim.cursor?[claim.cursor]:[]);
 function wall(){const value=evidenceDateSchema.parse(deps.now());if(Date.parse(value)<Date.parse(input.startedAt))throw new Error('Source clock moved before its attempt.');return value;}
 function elapsed(){const value=clock();if(!Number.isFinite(value)||value<start)throw new Error('Source monotonic clock moved backwards.');return value-start;}
 function summary():Summary{return {runId,claim:structuredClone(claim),pages,observations,reason};}
 async function interrupted<T>(operation:()=>Promise<T>):Promise<T>{
  if(controller.signal.aborted)throw new SourceReadError('timeout','Source read was cancelled.');let stop!:()=>void;
  const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(new SourceReadError('timeout','Source read was cancelled.'));controller.signal.addEventListener('abort',stop,{once:true});});
  try{return await Promise.race([operation(),aborted]);}finally{controller.signal.removeEventListener('abort',stop);}
 }
 async function current():Promise<SourceSyncResult|null>{try{if(await deps.isCurrent(structuredClone(claim),wall())===true)return null;reason='claim_changed';return {...summary(),status:'conflict',run};}catch{reason='storage_uncertain';return {...summary(),status:'uncertain',phase:'claim-check',run};}}
 async function finish(outcome:SourceRunHistory['outcome'],failure:SourceFailure|null=null,retryAfterMs:number|null=null):Promise<SourceSyncResult>{
  const now=wall();run={id:runId,sourceId:claim.sourceId,startedAt:input.startedAt,finishedAt:now,outcome,pages,observations,failure,retryAt:retryAfterMs===null?null:new Date(Date.parse(now)+Math.max(1,Math.min(retryAfterMs,86_400_000))).toISOString(),sourceRevision};
  try{const result=await deps.finishRun(structuredClone(claim),{run:structuredClone(run),now});if(result.status==='conflict'){reason='claim_changed';return {...summary(),status:'conflict',run};}if(result.outcome!==outcome||result.operationalRevision!==claim.operationalRevision+1||result.jobRevision!==claim.jobRevision+1){reason='storage_uncertain';return {...summary(),status:'uncertain',phase:'run-finish',run};}return {...summary(),status:outcome==='success'||outcome==='unchanged'?'completed':outcome,run,finish:result};}
  catch{reason='storage_uncertain';return {...summary(),status:'uncertain',phase:'run-finish',run};}
 }
 try{
  const initial=await current();if(initial)return initial;
  if(externalCancelled){reason='cancelled';return await finish('cancelled');}
  if(deadlineExpired||elapsed()>=SOURCE_LIMITS.runProviderMs){reason='time_budget';return await finish('partial');}
  if(claim.accessMode!=='manual'){
   try{const mode=claim.accessMode,caps=await interrupted(()=>deps.adapter.capabilities(mode));if(!caps.sourceKinds.includes(target.kind)||caps.blockedReason!==null||!caps.verifiedAt||!evidenceDateSchema.safeParse(caps.verifiedAt).success||!(mode==='interactive'?caps.interactiveRead:caps.unattendedRead))throw new SourceReadError('unsupported','The selected source mode has no verified provider read.');}
   catch(error){return await fail(error);}
  }
  for(;;){
   if(externalCancelled){reason='cancelled';return await finish('cancelled');}
   if(deadlineExpired||elapsed()>=SOURCE_LIMITS.runProviderMs){reason='time_budget';return await finish('partial');}
   if(pages>=SOURCE_LIMITS.runPages){reason='page_budget';return await finish('partial');}
   // No remaining-count hint exists in SourceAdapter. Do not read a page whose
   // allowed 100 observations could exceed the remaining 250-observation budget.
   if(SOURCE_LIMITS.runObservations-observations<SOURCE_LIMITS.pageObservations){reason='observation_budget';return await finish('partial');}
   const authority=await current();if(authority)return authority;
   let page:SourcePage,proposals:SourceProposal[];
   try{
    const observedAt=wall();page=sourcePageSchema.parse(await interrupted(()=>deps.adapter.readPage(structuredClone(target),{cursor:claim.cursor,etag:claim.etag,observedAt,signal:controller.signal})));
    if(page.nextCursor!==null&&visited.has(page.nextCursor)){reason='no_progress';throw new SourceReadError('invalid_content','Source pagination did not make forward progress.');}
    for(const observation of page.observations){if(observation.sourceId!==claim.sourceId||observation.origin!==(claim.accessMode==='manual'?'manual-import':'provider-read')||observation.observedAt!==observedAt||observation.contentDigest!==await contentHash(canonical(observation.payload)))throw new SourceReadError('invalid_content','Source observation identity, origin, date or digest differs.');}
    proposals=z.array(sourceProposalSchema).max(100).parse(deps.buildProposals?await interrupted(()=>deps.buildProposals!(structuredClone(page),structuredClone(claim))):[]);
    if(new Set(page.observations.map(value=>value.id)).size!==page.observations.length||new Set(proposals.map(value=>value.id)).size!==proposals.length||new Set(proposals.map(value=>value.dedupKey)).size!==proposals.length||new TextEncoder().encode(canonical({page,proposals})).length>SOURCE_LIMITS.pageBytes)throw new SourceReadError('invalid_content','Source page identities or combined byte bound differ.');
    try{for(const value of proposals)assertProposalFieldsAllowed(value.entity.kind,value.fields);}catch{throw new SourceReadError('invalid_content','Source proposal contains a field outside the safe review contract.');}
    if(proposals.some(value=>Date.parse(value.createdAt)>Date.parse(wall())||value.sourceId!==claim.sourceId||value.state!=='pending'||value.decision!==null))throw new SourceReadError('invalid_content','Source preparation can only propose pending owner review.');
   }catch(error){return await fail(error);}
   if(externalCancelled){reason='cancelled';return await finish('cancelled');}
   if(deadlineExpired||elapsed()>=SOURCE_LIMITS.runProviderMs){reason='time_budget';return await finish('partial');}
   const authorityAfterRead=await current();if(authorityAfterRead)return authorityAfterRead;
   const pendingPage={page:structuredClone(page),proposals:structuredClone(proposals),now:wall()};
   let result:SourcePageCommitResult;
   try{result=await deps.commitPage(structuredClone(claim),structuredClone(pendingPage));}
   catch{reason='storage_uncertain';return {...summary(),status:'uncertain',phase:'page-commit',run:null,pendingPage};}
   if(result.status==='conflict'){reason='claim_changed';return {...summary(),status:'conflict',run:null};}
   const next=claimSchema.safeParse(result.claim);
   if(!next.success||canonical({...next.data,operationalRevision:claim.operationalRevision,jobRevision:claim.jobRevision,cursor:claim.cursor,etag:claim.etag})!==canonical(claim)||next.data.operationalRevision!==claim.operationalRevision+1||next.data.jobRevision!==claim.jobRevision+1||next.data.cursor!==page.nextCursor||next.data.etag!==page.nextEtag||!Number.isSafeInteger(result.observationsInserted)||result.observationsInserted<0||result.observationsInserted>page.observations.length||!Number.isSafeInteger(result.proposalsInserted)||result.proposalsInserted<0||result.proposalsInserted>proposals.length){reason='storage_uncertain';return {...summary(),status:'uncertain',phase:'page-commit',run:null,pendingPage};}
   claim=next.data;pages++;observations+=page.observations.length;changed ||=result.observationsInserted>0||result.proposalsInserted>0;
   sourceRevision=page.observations.at(-1)?.sourceRevision??sourceRevision;
   if(externalCancelled){reason='cancelled';return await finish('cancelled');}
   if(page.nextCursor===null){reason='complete';return await finish(changed?'success':'unchanged');}
   visited.add(page.nextCursor);
  }
 }finally{timers.clear(timer);deps.signal?.removeEventListener('abort',cancel);}
 async function fail(error:unknown):Promise<SourceSyncResult>{
  if(externalCancelled){reason='cancelled';return finish('cancelled');}
  const failure=error instanceof SourceReadError&&sourceFailureSchema.safeParse(error.code).success?error:new SourceReadError(error instanceof z.ZodError?'invalid_content':'upstream_error','Source refresh did not return a confirmed valid page.');
  if(reason!=='no_progress')reason='provider_failure';
  const retry=failure.code==='rate_limited'?typeof failure.retryAfterMs==='number'&&Number.isFinite(failure.retryAfterMs)&&failure.retryAfterMs>=0?failure.retryAfterMs:60_000:['upstream_error','timeout'].includes(failure.code)?30_000:null;
  return finish('failed',failure.code,retry);
 }
}
