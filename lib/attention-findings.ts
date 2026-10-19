import {z} from 'zod';
import type {Workspace} from './types.ts';
import type {AttentionItem} from './attention.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {evidenceDateSchema as stamp,evidenceIdSchema as id,evidenceSubjectSchema} from './evidence-validation.ts';
import {sourceConnectionSchema,sourceTargetSchema,sourceFailureSchema} from './sources/validation.ts';
import {automationScheduleSchema,automationFailureSchema} from './automations/validation.ts';
import {jobReadModelSchema} from './agents/read-model.ts';
import {validateEvaluationObservation} from './agents/evaluation-import.ts';
import {parseReviewLink,reviewHref} from './review-links.ts';
import {entityHref,parseEntityLink} from './entity-links.ts';
const revision=z.number().int().positive().safe(),count=z.number().int().nonnegative().safe();
export const attentionSourceListSchema=z.object({revision,asOf:stamp,connections:z.array(z.object({value:sourceConnectionSchema,rowRevision:revision}).strict()).max(100),targets:z.array(z.object({value:sourceTargetSchema,rowRevision:revision,state:z.object({paused:z.boolean(),operationalRevision:revision,attemptedAt:stamp.nullable(),lastSuccessAt:stamp.nullable(),lastSourceRevision:z.string().max(4096).nullable(),failure:sourceFailureSchema.nullable(),retryAt:stamp.nullable(),failureCount:count}).strict().nullable(),manualImportAvailable:z.boolean(),automaticRead:z.literal('unverified')}).strict()).max(100)}).strict();
export const attentionScheduleListSchema=z.object({revision,asOf:stamp,schedules:z.array(z.object({value:automationScheduleSchema,rowRevision:revision,runtime:z.object({paused:z.boolean(),nextDueAt:stamp,lastAttemptAt:stamp.nullable(),lastSuccessAt:stamp.nullable(),failure:z.union([automationFailureSchema,sourceFailureSchema]).nullable(),retryAt:stamp.nullable()}).strict().nullable(),canResume:z.boolean()}).strict()).max(100),unattended:z.literal('unverified')}).strict();
export const attentionReviewSchema=z.object({revision,asOf:stamp,items:z.array(z.object({id:z.string().min(1).max(300),kind:z.enum(['missing-evidence','assessment-review','decision-review']),subject:evidenceSubjectSchema.optional(),projectId:id.nullable(),title:z.string().min(1).max(1000),reasons:z.array(z.string().max(20000)).max(10000),href:z.string().max(4096)}).strict()).max(10000)}).strict();
export interface OwnerAttentionFindings {revision:number;findings:AttentionItem[];readAt:{evidence:string;sources:string;schedules:string;jobs:string}}
const bytes=(value:unknown)=>new TextEncoder().encode(canonical(value)).length;
function unique(ids:string[]){if(new Set(ids).size!==ids.length)throw new Error('Attention source has ambiguous identities.');}
function localHref(href:string,workspace:Workspace):string{
 if(!href.startsWith('/?')||href.includes('#'))throw new Error('Invalid attention citation.');
 if(href==='/?view=evidence')return href;
 const review=parseReviewLink(href);if(review.status==='valid'){const expected=reviewHref(review.target);if(href!==expected)throw new Error('Invalid attention citation.');return expected;}
 const entity=parseEntityLink(href,workspace);if(entity.status==='available'){const expected=entityHref(entity.target);if(new URLSearchParams(href.slice(2)).toString()!==new URLSearchParams(expected.slice(2)).toString())throw new Error('Invalid attention citation.');return expected;}
 throw new Error('Invalid attention citation.');
}
const failedSourceReason=(failure:string)=>failure==='storage_capacity'?'Recovery storage capacity requires owner review.':failure==='reauthentication_required'||failure==='request_context_expired'?'Source authentication requires owner review.':failure==='rate_limited'?'The recorded source attempt was rate limited.':failure==='timeout'?'The recorded source attempt timed out.':'The recorded source attempt did not complete; review its source status.';
/** Derived owner metadata only. Never supplies attachment verification or current provider authority. */
export async function deriveOwnerAttentionFindings(workspace:Workspace,expectedRevision:number,input:{review:unknown;sources:unknown;schedules:unknown;jobs:unknown[]}):Promise<OwnerAttentionFindings>{
 revision.parse(expectedRevision);if(bytes(input)>8_000_000)throw new Error('Owner attention exceeds its aggregate byte limit.');
 const review=attentionReviewSchema.parse(input.review),sources=attentionSourceListSchema.parse(input.sources),schedules=attentionScheduleListSchema.parse(input.schedules);
 if(!input.jobs.length||input.jobs.length>200)throw new Error('Invalid job attention pages.');
 const pages=input.jobs.map(value=>jobReadModelSchema.parse(value));
 for(const value of [review,sources,schedules,...pages])if(value.revision!==expectedRevision)throw new Error('Owner attention revision changed. Refresh the workspace.');
 unique(review.items.map(row=>row.id));unique(sources.connections.map(row=>row.value.id));unique(sources.targets.map(row=>row.value.id));unique(schedules.schedules.map(row=>row.value.id));
 const findings:AttentionItem[]=[],projects=new Set(workspace.projects.map(row=>row.id));
 const add=(item:AttentionItem)=>{if(item.projectId!==null&&!projects.has(item.projectId))throw new Error('Attention project is unavailable.');findings.push(item);};
 for(const row of review.items){
  const subject=row.subject,subjectExists=subject? (subject.type==='project'?workspace.projects:subject.type==='task'?workspace.tasks:subject.type==='milestone'?workspace.milestones:workspace.captures).some(value=>value.id===subject.id):false;
  const kind=row.kind==='missing-evidence'?'missing-evidence':'review',entityType=subjectExists&&subject?subject.type:(row.kind==='decision-review'?'decision':'evidence'),entityId=subjectExists&&subject?subject.id:row.id;
  add({key:`${kind}:${entityType}:${entityId}`,kind,entityType,entityId,projectId:row.projectId,title:row.title,reasons:[...row.reasons,...(subject&&!subjectExists?['The recorded subject is unavailable in current planning; review its retained historical context.']:[])],href:localHref(row.href,workspace),reviewLinks:[{href:localHref(row.href,workspace),label:row.title}],severity:'review',sortAt:null});
 }
 const connections=new Map(sources.connections.map(row=>[row.value.id,row.value]));
 for(const row of sources.targets){
  const target=row.value,connection=connections.get(target.connectionId);if(!connection)throw new Error('Attention source connection is unavailable.');if(target.archivedAt||connection.archivedAt)continue;
  const state=row.state,reasons:string[]=[];
  if(!connection.enabled)reasons.push('The selected connection is disabled.');
  if(state?.paused)reasons.push('Source synchronization is paused.');
  if(state?.failure)reasons.push(failedSourceReason(state.failure));
  const success=state?.lastSuccessAt??null;
  if(success===null)reasons.push('No successful source read is recorded. Observation time and current freshness are unknown.');
  else if(Date.parse(success)>Date.parse(sources.asOf))reasons.push('The recorded success time is ahead of this read; current freshness is unknown.');
  else if(Date.parse(sources.asOf)-Date.parse(success)>=target.staleAfterSeconds*1000)reasons.push('The recorded successful source read is older than its selected freshness interval.');
  // The current owner API intentionally does not attest a live provider connection.
  reasons.push('Automatic provider access is unverified; this selection is not a connected or fresh provider claim.');
  add({key:'stale-source:source:'+target.id,kind:'stale-source',entityType:'source',entityId:target.id,projectId:target.projectId,title:'Review selected source',reasons,href:'/?view=sources',severity:state?.failure?'action':'review',sortAt:success});
 }
 for(const row of schedules.schedules){
  const schedule=row.value,runtime=row.runtime;if(schedule.archivedAt||!schedule.enabled)continue;
  if(runtime&&!runtime.paused&&!runtime.failure&&row.canResume)continue;
  const reasons=['Unattended runner availability is unverified; this schedule is not a live execution claim.'];
  if(!runtime)reasons.push('No schedule runtime or successful attempt is recorded.');
  if(runtime?.paused)reasons.push('This schedule is paused and needs explicit owner review before resuming.');
  if(runtime?.failure)reasons.push(runtime.failure==='storage_capacity'?'Recovery storage capacity blocked this schedule.':'The recorded schedule attempt is blocked or failed.');
  if(!row.canResume)reasons.push('Required registered runner, private storage or source authority is unavailable.');
  const projectId=schedule.projectIds.length===1?schedule.projectIds[0]:null;
  add({key:'failed-job:job:schedule:'+schedule.id,kind:'failed-job',entityType:'job',entityId:'schedule:'+schedule.id,projectId,title:'Review blocked schedule',reasons,href:'/?view=reviews',severity:'review',sortAt:runtime?.lastAttemptAt??null});
 }
 if(pages.at(-1)!.nextJobAfter!==null)throw new Error('Job attention is incomplete.');
 for(let index=0;index<pages.length;index++){const page=pages[index];for(let n=1;n<page.jobs.length;n++)if(page.jobs[n].record.id<=page.jobs[n-1].record.id)throw new Error('Job attention order differs.');if(index>0){const previous=pages[index-1];if(previous.nextJobAfter===null||!page.jobs.length||page.jobs[0].record.id<=previous.nextJobAfter)throw new Error('Job attention page boundary differs.');}}
 const jobs=pages.flatMap(page=>page.jobs);if(jobs.length>10000)throw new Error('Job attention exceeds its record limit.');unique(jobs.map(row=>row.record.id));
 for(const page of pages)for(const evaluation of page.evaluations)await validateEvaluationObservation(evaluation);
 for(const row of jobs){
  if(await contentHash(canonical(row.record.spec))!==row.record.specSha256||row.result&&await contentHash(canonical(row.result))!==row.resultHash||row.approvalCandidate&&await contentHash(canonical(row.approvalCandidate.binding))!==row.approvalCandidate.bindingHash)throw new Error('Job attention digest differs.');
  if(!['failed','blocked','reconcile_required'].includes(row.status)&&!row.attempt?.terminationUnconfirmed)continue;
  const reasons=['Job '+row.record.id+'.',row.status==='reconcile_required'||row.attempt?.terminationUnconfirmed?'The attempt outcome or process exit is unconfirmed. Review reconciliation before any new attempt.':row.status==='blocked'?'The recorded job is blocked. Review its verified capability, policy and approval requirements.':'The recorded job failed. Review the immutable attempt and result before proposing another attempt.'];
  if(!projects.has(row.record.spec.projectId))reasons.push('The recorded project is unavailable in current planning; this finding remains historical context.');
  if(row.record.historical)reasons.push('This is imported historical context; it carries no current execution authority.');
  const diagnostic=row.result?.diagnostic??row.attempt?.diagnostic;
  if(diagnostic&&diagnostic!=='ok')reasons.push('Recorded diagnostic: '+diagnostic+'.');
  add({key:'failed-job:job:'+row.record.id,kind:'failed-job',entityType:'job',entityId:row.record.id,projectId:projects.has(row.record.spec.projectId)?row.record.spec.projectId:null,title:'Review agent job',reasons,href:'/?view=agents',severity:row.status==='reconcile_required'?'action':'review',sortAt:row.attempt?.lastEventAt??row.attempt?.startedAt??null});
 }
 if(findings.length>10000||bytes(findings)>8_000_000)throw new Error('Owner attention findings exceed their bounded limit.');
 return {revision:expectedRevision,findings,readAt:{evidence:review.asOf,sources:sources.asOf,schedules:schedules.asOf,jobs:pages[0].generatedAt}};
}
/** One bounded flight; follows every owner job cursor or fails visibly, never truncates. */
export async function loadOwnerAttentionFindings(workspace:Workspace,expectedRevision:number,read:(path:string)=>Promise<unknown>):Promise<OwnerAttentionFindings>{
 let used=0;const get=async(path:string)=>{const value=await read(path);used+=bytes(value);if(used>8_000_000)throw new Error('Owner attention exceeds its aggregate byte limit.');return value;};
 const review=await get('/api/evidence/attention'),sources=await get('/api/sources'),schedules=await get('/api/automations'),jobs:unknown[]=[],seen=new Set<string>();let after:string|null=null;
 for(let page=0;page<200;page++){
  const value=await get('/api/jobs'+(after?'?afterJob='+encodeURIComponent(after):'')),parsed=jobReadModelSchema.parse(value);jobs.push(value);
  if(parsed.revision!==expectedRevision)throw new Error('Owner attention revision changed. Refresh the workspace.');
  if(parsed.nextJobAfter===null)return deriveOwnerAttentionFindings(workspace,expectedRevision,{review,sources,schedules,jobs});
  if(seen.has(parsed.nextJobAfter)||after!==null&&parsed.nextJobAfter<=after)throw new Error('Job attention cursor did not advance.');seen.add(parsed.nextJobAfter);after=parsed.nextJobAfter;
 }
 throw new Error('Job attention pagination exceeds its bounded limit.');
}
