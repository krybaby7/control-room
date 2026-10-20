import { z } from 'zod';
import { evidenceIdSchema, evidenceDateSchema } from './evidence-validation.ts';
import { canonical, contentHash } from './canonical-json.ts';
import type { AcceptanceEvidenceRef, AttachmentRecord, EvidenceLink, EvidenceRequirement, EvidenceSubject, EvidenceVersion, RequirementCriteria, VersionedRecordHead } from './evidence-contract.ts';

export const claimScopeSchema=z.enum(['implementation','software-verification','physical-acceptance','operation','release-acceptance','economics']);
export const evidenceSubjectSchema=z.object({type:z.enum(['project','milestone','task','capture']),id:evidenceIdSchema}).strict();
export const requirementCriteriaSchema=z.object({id:evidenceIdSchema,label:z.string().min(1).max(200).refine(value=>Boolean(value.trim())),scope:claimScopeSchema,required:z.boolean(),maxAgeDays:z.number().finite().nonnegative().max(36500).nullable(),candidate:z.string().min(1).max(500).refine(value=>Boolean(value.trim())).nullable(),requireAttachment:z.boolean()}).strict();
export const evidenceRequirementSchema=requirementCriteriaSchema.extend({subject:evidenceSubjectSchema,archivedAt:evidenceDateSchema.nullable()}).strict();
export function sameSubject(a:EvidenceSubject,b:EvidenceSubject):boolean{return a.type===b.type&&a.id===b.id;}
export function asOfTime(asOf:string):number {evidenceDateSchema.parse(asOf);const n=Date.parse(asOf);if(!Number.isFinite(n))throw new Error('A valid explicit asOf is required');return n;}
export function requirementFindings(requirement:RequirementCriteria,evidence:EvidenceVersion[],asOf:string):string[]{
 const now=asOfTime(asOf);const matching=evidence.filter(e=>e.scope===requirement.scope&&(requirement.candidate===null||e.candidate===requirement.candidate)&&(!requirement.requireAttachment||e.attachmentIds.length>0));
 if(!matching.length)return requirement.required?[`${requirement.label}: missing matching evidence`]:[];
 if(requirement.maxAgeDays===null)return [];
 return matching.some(e=>e.observedAt!==null&&Date.parse(e.observedAt)>=now-requirement.maxAgeDays!*86400000&&Date.parse(e.observedAt)<=now)?[]:[`${requirement.label}: evidence date is unknown or outside its freshness window`];
}
export interface VerifiedAttachment {record:AttachmentRecord;verifiedSha256:string;verifiedBytes:number;signatureVerified:boolean}
/** All records supplied here must already have been selected within the authenticated owner. */
export interface RequirementContext {subject:EvidenceSubject;candidate:string|null;asOf:string;requirements:EvidenceRequirement[];evidence:EvidenceVersion[];heads:VersionedRecordHead[];links:EvidenceLink[];evidenceRefs:AcceptanceEvidenceRef[];attachments:VerifiedAttachment[]}
export interface RequirementFinding {code:string;message:string;requirementId:string|null;required:boolean;blocking:boolean;nonWaivable:boolean;scope?:RequirementCriteria['scope'];sources?:{linkId:string;id:string;version:number}[]}
export interface RequirementAssessment {criteriaHash:string;findings:RequirementFinding[];requirements:{requirement:EvidenceRequirement;satisfied:boolean}[];canAccept:boolean}
export async function criteriaHash(subject:EvidenceSubject,requirements:EvidenceRequirement[]):Promise<string>{
 const active=requirements.map(r=>evidenceRequirementSchema.parse(r)).filter(r=>r.archivedAt===null&&sameSubject(r.subject,subject)).sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(active.map(r=>r.id)).size!==active.length)throw new Error('Duplicate requirement IDs');
 return contentHash(canonical({subject:evidenceSubjectSchema.parse(subject),criteria:active.map(r=>({id:r.id,label:r.label,scope:r.scope,required:r.required,maxAgeDays:r.maxAgeDays,candidate:r.candidate,requireAttachment:r.requireAttachment}))}));
}
export async function evaluateRequirements(context:RequirementContext):Promise<RequirementAssessment>{
 const now=asOfTime(context.asOf);const hash=await criteriaHash(context.subject,context.requirements);const findings:RequirementFinding[]=[];
 const active=context.requirements.filter(r=>r.archivedAt===null&&sameSubject(r.subject,context.subject));
 const add=(code:string,message:string,r:EvidenceRequirement|null,nonWaivable=false,blocking=r?.required??true)=>findings.push({code,message,requirementId:r?.id??null,required:r?.required??true,blocking,nonWaivable,...(r?{scope:r.scope}:{})});
 const refKeys=new Set<string>();
 for(const ref of context.evidenceRefs){const key=canonical(ref);if(refKeys.has(key))add('duplicate-ref','Duplicate evidence selection',null,true);refKeys.add(key);if(!active.some(r=>r.id===ref.requirementId))add('unknown-requirement','Evidence selection does not name an active subject criterion',null,true);}
 const results=active.map(requirement=>{
  let satisfied=false;const selected=context.evidenceRefs.filter(ref=>ref.requirementId===requirement.id);
  for(const ref of selected){
   const evidence=context.evidence.filter(e=>e.id===ref.id&&e.version===ref.version);const heads=context.heads.filter(h=>h.id===ref.id);
   const linked=context.links.some(l=>l.evidenceId===ref.id&&l.evidenceVersion===ref.version&&l.requirementId===requirement.id&&l.relation===ref.relation&&sameSubject(l.subject,context.subject));
   if(evidence.length!==1||heads.length!==1||!linked){add('unresolved-ref',`${requirement.label}: exact evidence version/link is unavailable`,requirement,true,true);continue;}
   const e=evidence[0],head=heads[0];
   if(head.currentVersion<e.version||(!ref.historical&&head.currentVersion!==e.version)||head.archivedAt!==null){add('history-head',`${requirement.label}: archived or historical evidence requires review`,requirement,true,true);continue;}
   if(ref.relation!=='supports')continue;
   let valid=true;const fail=(code:string,message:string)=>{valid=false;add(code,`${requirement.label}: ${message}`,requirement);};
   if(e.scope!==requirement.scope)fail('scope','evidence claim scope does not match');
   if((requirement.candidate!==null&&e.candidate!==requirement.candidate)||(context.candidate!==null&&e.candidate!==context.candidate))fail('candidate','evidence candidate does not match');
   if(!Number.isFinite(Date.parse(e.recordedAt))||Date.parse(e.recordedAt)>now)fail('future-record','evidence recording date is invalid or in the future');
   const observed=e.observedAt===null?NaN:Date.parse(e.observedAt);
   if(Number.isFinite(observed)&&observed>now)fail('future-observation','evidence observation is in the future');
   if(requirement.maxAgeDays!==null&&(!Number.isFinite(observed)||observed<now-requirement.maxAgeDays*86400000))fail('freshness','evidence date is unknown or outside its freshness window');
   else if(!Number.isFinite(observed))add('unknown-date',`${requirement.label}: observation date is unknown`,requirement,false,false);
   if(e.environment===null)add('unknown-environment',`${requirement.label}: environment is unknown`,requirement,false,false);
   if(e.candidate===null)add('unknown-candidate',`${requirement.label}: candidate is unknown`,requirement,false,false);
   if(requirement.requireAttachment&&!e.attachmentIds.length)fail('attachment','ready verified attachment is required');
   for(const id of e.attachmentIds){const proofs=context.attachments.filter(a=>a.record.id===id);const proof=proofs[0];const a=proof?.record;
    if(proofs.length!==1||!a||a.status!=='ready'||!proof.signatureVerified||!a.sha256||!/^[a-f0-9]{64}$/.test(a.sha256)||a.sha256!==proof.verifiedSha256||a.actualBytes!==a.expectedBytes||a.actualBytes!==proof.verifiedBytes||!Number.isSafeInteger(proof.verifiedBytes)||proof.verifiedBytes<0||a.readyAt===null||!Number.isFinite(Date.parse(a.readyAt))||Date.parse(a.readyAt)>now||!Number.isFinite(Date.parse(a.createdAt))||Date.parse(a.createdAt)>now)fail('attachment','attachment is not ready with verified bytes and signature');
   }
   if(valid)satisfied=true;
  }
  const contradictions=context.links.filter(l=>l.relation==='contradicts'&&l.requirementId===requirement.id&&sameSubject(l.subject,context.subject));
  if(contradictions.length){satisfied=false;add('contradiction',`${requirement.label}: linked contradictory evidence needs an explicit decision`,requirement);findings[findings.length-1].sources=contradictions.map(l=>({linkId:l.id,id:l.evidenceId,version:l.evidenceVersion}));}
  if(!satisfied)add('missing',`${requirement.label}: missing matching evidence`,requirement);
  return {requirement,satisfied};
 });
 return {criteriaHash:hash,findings,requirements:results,canAccept:!findings.some(f=>f.blocking)};
}
