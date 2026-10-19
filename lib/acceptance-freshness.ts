import {canonical} from './canonical-json.ts';
import {acceptanceRecordSchema,type AcceptancePreviewContext} from './acceptance.ts';
import {asOfTime,evaluateRequirements,sameSubject,type RequirementFinding} from './evidence-requirements.ts';
import type {AcceptanceRecord} from './evidence-contract.ts';
export interface AcceptanceFreshness {state:'current'|'needs-review'|'historical-claim';findings:RequirementFinding[];reasons:string[]}
/** Current validity read only. Never rewrites the historical time, outcome or evidence selection. */
export async function assessAcceptanceFreshness(input:AcceptanceRecord,context:AcceptancePreviewContext&{trustedRecord:boolean}):Promise<AcceptanceFreshness>{
 const record=acceptanceRecordSchema.parse(input),now=asOfTime(context.asOf);
 if(!context.trustedRecord)return {state:'historical-claim',findings:[],reasons:['This acceptance is retained as a historical claim; current owner acceptance authority is not established.']};
 const assessment=await evaluateRequirements({...context,subject:record.subject,candidate:record.candidate,evidenceRefs:record.evidenceRefs});const findings=[...assessment.findings],reasons:string[]=[];
 const reason=(message:string)=>{if(!reasons.includes(message))reasons.push(message);};
 if(!sameSubject(record.subject,context.subject)||record.candidate!==context.candidate)reason('The acceptance subject or candidate differs from the current reviewed context.');
 if(Date.parse(record.recordedAt)>now)reason('The acceptance recording time is in the future of the assessment.');
 if(record.criteriaHash!==assessment.criteriaHash)reason('The subject criteria changed after this acceptance.');
 if((context.priorAcceptances??[]).some(row=>row.supersedesId===record.id))reason('A later acceptance supersedes this historical record.');
 for(const ref of record.evidenceRefs){const heads=context.heads.filter(head=>head.id===ref.id);if(heads.length!==1||heads[0].currentVersion!==ref.version||heads[0].archivedAt!==null)reason(`Evidence ${ref.id} version ${ref.version} is no longer the current unarchived source.`);}
 const waived=new Set<string>(),used=new Set<string>();
 for(const exception of record.exceptions){const key=canonical([exception.decisionId,exception.decisionVersion]);const versions=(context.trustedDecisionVersions??[]).filter(d=>d.id===exception.decisionId&&d.version===exception.decisionVersion);const heads=(context.trustedDecisionHeads??[]).filter(h=>h.id===exception.decisionId);const d=versions[0],h=heads[0],grant=d?.exception;
  const valid=versions.length===1&&heads.length===1&&h.archivedAt===null&&h.currentVersion===exception.decisionVersion&&d.status==='decided'&&d.selectedOptionId!==null&&d.options.some(o=>o.id===d.selectedOptionId)&&d.rationale.trim().length>0&&d.subjects.some(subject=>sameSubject(subject,record.subject))&&d.decidedAt!==null&&Number.isFinite(Date.parse(d.decidedAt))&&Date.parse(d.decidedAt)<=now&&Number.isFinite(Date.parse(d.recordedAt))&&Date.parse(d.recordedAt)<=now&&grant&&grant.scope===exception.scope&&Date.parse(grant.expiresAt)===Date.parse(exception.expiresAt)&&Date.parse(exception.expiresAt)>now&&canonical([...grant.requirementIds].sort())===canonical([...exception.requirementIds].sort())&&exception.requirementIds.every(id=>assessment.requirements.some(r=>r.requirement.id===id&&r.requirement.scope===exception.scope));
  if(!valid||used.has(key)){reason(`Exception decision ${exception.decisionId} version ${exception.decisionVersion} is revoked, expired or unavailable in its exact authorized scope.`);continue;}used.add(key);exception.requirementIds.forEach(id=>waived.add(id));
 }
 const invalidCodes=new Set(['unresolved-ref','history-head','scope','candidate','future-record','future-observation','freshness','attachment','contradiction','duplicate-ref','unknown-requirement']);
 for(const finding of findings){if(finding.nonWaivable||((finding.blocking||invalidCodes.has(finding.code))&&(finding.requirementId===null||!waived.has(finding.requirementId))))reason(finding.message);}
 if(record.decision==='accepted'&&record.subject.type==='milestone'&&!assessment.requirements.some(r=>r.requirement.required))reason('Milestone acceptance no longer has a required criterion.');
 return {state:reasons.length?'needs-review':'current',findings,reasons};
}
