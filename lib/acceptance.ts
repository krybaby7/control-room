import {z} from 'zod';
import {evidenceIdSchema,evidenceDateSchema} from './evidence-validation.ts';
import {canonical} from './canonical-json.ts';
import {asOfTime,claimScopeSchema,evaluateRequirements,evidenceSubjectSchema,sameSubject} from './evidence-requirements.ts';
import type {RequirementContext,RequirementFinding} from './evidence-requirements.ts';
import type {AcceptanceRecord,DecisionVersion,VersionedRecordHead} from './evidence-contract.ts';
const id=evidenceIdSchema,version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),date=evidenceDateSchema;
export const acceptanceEvidenceRefSchema=z.object({id,version,requirementId:id,relation:z.enum(['supports','contradicts','context']),historical:z.boolean()}).strict();
export const acceptanceExceptionSchema=z.object({decisionId:id,decisionVersion:version,scope:claimScopeSchema,expiresAt:date,requirementIds:z.array(id).min(1).max(200).refine(ids=>new Set(ids).size===ids.length,'Duplicate requirement IDs')}).strict();
export const acceptanceRecordSchema=z.object({id,subject:evidenceSubjectSchema,decision:z.enum(['accepted','rejected','needs-review']),statement:z.string().trim().min(1).max(10000),candidate:z.string().min(1).max(500).refine(value=>Boolean(value.trim())).nullable(),criteriaHash:z.string().regex(/^[a-f0-9]{64}$/),evidenceRefs:z.array(acceptanceEvidenceRefSchema).max(200).refine(refs=>new Set(refs.map(canonical)).size===refs.length,'Duplicate evidence refs'),recordedAt:date,supersedesId:id.nullable(),exceptions:z.array(acceptanceExceptionSchema).max(200)}).strict();
export interface AcceptancePreviewContext extends Omit<RequirementContext,'evidenceRefs'> {trustedOrigin:'owner'|'connector'|'proposal';trustedDecisionVersions?:DecisionVersion[];trustedDecisionHeads?:VersionedRecordHead[];priorAcceptances?:AcceptanceRecord[]}
export interface AcceptancePreview {canRecord:boolean;canAccept:boolean;record:AcceptanceRecord|null;findings:RequirementFinding[];errors:string[];waivedRequirementIds:string[];supersedes:AcceptanceRecord|null;criteriaHash:string|null}
/** Pure preview: origin and owner-scoped records must be injected by trusted server code. */
export async function previewAcceptance(input:unknown,context:AcceptancePreviewContext):Promise<AcceptancePreview>{
 const parsed=acceptanceRecordSchema.safeParse(input);const errors:string[]=[];
 if(!parsed.success)return {canRecord:false,canAccept:false,record:null,findings:[],errors:parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`),waivedRequirementIds:[],supersedes:null,criteriaHash:null};
 const record=parsed.data;const now=asOfTime(context.asOf);
 if(context.trustedOrigin!=='owner')errors.push('Only an explicit owner decision can record acceptance');
 if(!sameSubject(record.subject,context.subject)||record.candidate!==context.candidate)errors.push('Acceptance subject or candidate differs from reviewed context');
 if(Date.parse(record.recordedAt)!==now)errors.push('Acceptance recording time must equal the server review time');
 const assessment=await evaluateRequirements({...context,evidenceRefs:record.evidenceRefs});
 if(record.criteriaHash!==assessment.criteriaHash)errors.push('Criteria changed since review');
 const prior=context.priorAcceptances??[];let supersedes:AcceptanceRecord|null=null;
 if(prior.some(p=>p.id===record.id))errors.push('Acceptance records are immutable');
 if(record.supersedesId!==null){const matches=prior.filter(p=>p.id===record.supersedesId);supersedes=matches[0]??null;if(matches.length!==1||!supersedes||!sameSubject(supersedes.subject,record.subject)||Date.parse(supersedes.recordedAt)>now||supersedes.id===record.id||prior.some(p=>p.supersedesId===record.supersedesId))errors.push('Superseded acceptance must be the available unsuperseded record for this subject');}
 const waived=new Set<string>(),decisions=new Set<string>();
 for(const exception of record.exceptions){
  const key=`${exception.decisionId}:${exception.decisionVersion}`;
  const versions=(context.trustedDecisionVersions??[]).filter(d=>d.id===exception.decisionId&&d.version===exception.decisionVersion);
  const heads=(context.trustedDecisionHeads??[]).filter(h=>h.id===exception.decisionId);const d=versions[0],h=heads[0];
  const grant=d?.exception;
  const exactGrant=grant&&grant.scope===exception.scope&&Date.parse(grant.expiresAt)===Date.parse(exception.expiresAt)&&canonical([...grant.requirementIds].sort())===canonical([...exception.requirementIds].sort());
  const valid=versions.length===1&&heads.length===1&&h.archivedAt===null&&h.currentVersion===exception.decisionVersion&&d.status==='decided'&&d.selectedOptionId!==null&&d.options.some(o=>o.id===d.selectedOptionId)&&d.rationale.trim().length>0&&d.subjects.some(s=>sameSubject(s,record.subject))&&d.decidedAt!==null&&Number.isFinite(Date.parse(d.decidedAt))&&Date.parse(d.decidedAt)<=now&&Number.isFinite(Date.parse(d.recordedAt))&&Date.parse(d.recordedAt)<=now&&Date.parse(exception.expiresAt)>now&&exactGrant&&exception.requirementIds.every(rid=>assessment.requirements.some(r=>r.requirement.id===rid&&r.requirement.scope===exception.scope));
  if(!valid||decisions.has(key)){errors.push(`Exception ${key} is not a current explicit scoped owner decision`);continue;}
  decisions.add(key);exception.requirementIds.forEach(rid=>waived.add(rid));
 }
 if(record.decision==='accepted'&&record.subject.type==='milestone'&&!assessment.requirements.some(r=>r.requirement.required))errors.push('Milestone acceptance requires at least one required criterion');
 const blockers=assessment.findings.filter(f=>f.blocking&&(f.nonWaivable||f.requirementId===null||!waived.has(f.requirementId)));
 if(assessment.findings.some(f=>f.nonWaivable))errors.push('Evidence selections are not valid exact owner subject references');
 const canAccept=errors.length===0&&blockers.length===0;
 if(record.decision==='accepted'&&!canAccept)errors.push('Required criteria need valid evidence or an explicit current scoped owner exception');
 return {canRecord:errors.length===0,canAccept,record,findings:assessment.findings,errors,waivedRequirementIds:[...waived].sort(),supersedes,criteriaHash:assessment.criteriaHash};
}
