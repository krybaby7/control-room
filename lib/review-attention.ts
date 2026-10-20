import type {Workspace} from './types.ts';
import type {EvidenceSnapshot} from './evidence-store.ts';
import type {EvidenceSubject,AcceptanceEvidenceRef,DecisionVersion} from './evidence-contract.ts';
import {evaluateRequirements,criteriaHash,sameSubject,asOfTime} from './evidence-requirements.ts';
import {assessAcceptanceFreshness} from './acceptance-freshness.ts';
import {canonical} from './canonical-json.ts';
import {cairoDate} from './calendar.ts';
import {reviewHref} from './review-links.ts';
export interface ReviewAttentionItem {id:string;kind:'missing-evidence'|'assessment-review'|'decision-review';subject?:EvidenceSubject;projectId:string|null;title:string;reasons:string[];href:string}
/** Trusted acceptance IDs are server-only, derived from exact owner/hash grants; never request input.
 * Default public snapshot context carries no acceptance authority or verified blob proof. */
export async function buildReviewAttention(workspace:Workspace,snapshot:EvidenceSnapshot,asOf:string,options:{trustedAcceptanceIds?:ReadonlySet<string>;trustedDecisionVersions?:readonly DecisionVersion[]}={}):Promise<ReviewAttentionItem[]>{
 asOfTime(asOf);const collections=[snapshot.evidenceHeads,snapshot.evidenceVersions,snapshot.evidenceMappings,snapshot.links,snapshot.requirements,snapshot.acceptances,snapshot.decisionHeads,snapshot.decisionVersions,snapshot.attachments];if(collections.reduce((n,rows)=>n+rows.length,workspace.projects.length+workspace.milestones.length+workspace.tasks.length+workspace.captures.length)>10000||new TextEncoder().encode(canonical({workspace,snapshot})).length>8_000_000)throw new Error('Review attention input exceeds bounded limit.');
 const items:ReviewAttentionItem[]=[];const project=(subject:EvidenceSubject):string|null=>subject.type==='project'?workspace.projects.find(p=>p.id===subject.id)?.id??null:subject.type==='task'?workspace.tasks.find(t=>t.id===subject.id)?.projectId??null:subject.type==='milestone'?workspace.milestones.find(m=>m.id===subject.id)?.projectId??null:workspace.captures.find(c=>c.id===subject.id)?.projectId??null;
 const title=(subject:EvidenceSubject)=>subject.type==='project'?workspace.projects.find(p=>p.id===subject.id)?.name??'Unavailable project':(subject.type==='task'?workspace.tasks:subject.type==='milestone'?workspace.milestones:workspace.captures).find(r=>r.id===subject.id)?.title??'Unavailable subject';
 const trustedDecisions=(options.trustedDecisionVersions??[]).filter(value=>snapshot.decisionVersions.some(row=>canonical(row)===canonical(value)));
 const context={trustedOrigin:'owner' as const,asOf,requirements:snapshot.requirements,evidence:snapshot.evidenceVersions,heads:snapshot.evidenceHeads,links:snapshot.links,attachments:[],trustedDecisionVersions:[...trustedDecisions],trustedDecisionHeads:snapshot.decisionHeads};
 for(const requirement of snapshot.requirements.filter(r=>r.required&&r.archivedAt===null)){
  const refs:AcceptanceEvidenceRef[]=snapshot.links.filter(l=>l.requirementId===requirement.id&&sameSubject(l.subject,requirement.subject)&&snapshot.evidenceHeads.some(h=>h.id===l.evidenceId&&h.currentVersion===l.evidenceVersion&&h.archivedAt===null)).map(l=>({id:l.evidenceId,version:l.evidenceVersion,requirementId:requirement.id,relation:l.relation,historical:false}));
  const unique=[...new Map(refs.map(r=>[canonical(r),r])).values()];const result=await evaluateRequirements({...context,subject:requirement.subject,candidate:requirement.candidate,requirements:[requirement],evidenceRefs:unique});
  const relevant=result.findings.filter(f=>f.requirementId===requirement.id);const attachmentUnknown=relevant.some(f=>f.code==='attachment');const reasons=[...new Set(relevant.map(f=>f.code==='attachment'?'Review actual attachment verification; metadata alone does not establish available or verified bytes.':f.code==='missing'&&attachmentUnknown?'This required criterion is not established by the available metadata-only review.':f.message))];
  const oldLinks=snapshot.links.filter(l=>l.requirementId===requirement.id&&sameSubject(l.subject,requirement.subject)&&!unique.some(r=>r.id===l.evidenceId&&r.version===l.evidenceVersion&&r.relation===l.relation));if(oldLinks.some(l=>l.relation==='supports'))reasons.push('Historical or archived support is retained as context; no current unarchived exact source was selected for it.');
  if(reasons.length)items.push({id:`requirement:${requirement.id}`,kind:'missing-evidence',subject:requirement.subject,projectId:project(requirement.subject),title:`Review evidence: ${requirement.label}`,reasons,href:'/?view=evidence'});
 }
 for(const record of snapshot.acceptances){
  const trustedRecord=options.trustedAcceptanceIds?.has(record.id)??false;
  const historical=await assessAcceptanceFreshness(record,{...context,subject:record.subject,candidate:record.candidate,trustedRecord,priorAcceptances:snapshot.acceptances});const reasons=[...historical.reasons.map(reason=>reason.includes('attachment is not ready with verified bytes and signature')?'Review actual attachment verification; metadata alone does not establish available or verified bytes.':reason.startsWith('Exception decision ')&&options.trustedDecisionVersions===undefined?'Exception authority is unverified in this contextual snapshot; request an authenticated owner assessment preview.':reason)];
  if(record.criteriaHash!==await criteriaHash(record.subject,snapshot.requirements))reasons.push('Current criteria differ from this immutable historical assessment.');
  if(record.evidenceRefs.some(ref=>!snapshot.evidenceHeads.some(h=>h.id===ref.id&&h.currentVersion===ref.version&&h.archivedAt===null)))reasons.push('A cited evidence head changed, was archived or is unavailable; inspect the exact historical citation.');
  if(record.exceptions.length&&options.trustedDecisionVersions===undefined)reasons.push('Exception authority, revocation and expiry require an authenticated owner assessment preview; public decision metadata is not a trusted grant.');
  if(record.evidenceRefs.some(ref=>snapshot.evidenceVersions.some(e=>e.id===ref.id&&e.version===ref.version&&e.attachmentIds.length)))reasons.push('Review actual attachment verification; this snapshot includes metadata only.');
  if(reasons.length)items.push({id:`assessment:${record.id}`,kind:'assessment-review',subject:record.subject,projectId:project(record.subject),title:`${trustedRecord?'Review assessment':'Contextual assessment'}: ${title(record.subject)}`,reasons,href:'/?view=evidence'});
 }
 const today=cairoDate(asOf);for(const decision of snapshot.decisionVersions){
  if(!snapshot.decisionHeads.some(h=>h.id===decision.id&&h.currentVersion===decision.version&&h.archivedAt===null)||decision.status==='superseded')continue;
  const reasons:string[]=[];
  if(decision.reviewOn!==null&&decision.reviewOn<=today)reasons.push(`Recorded review date ${decision.reviewOn} is due as of Cairo date ${today}.`);
  for(const linked of decision.subjects){const basis=decision.criteriaBasis?.find(value=>sameSubject(value.subject,linked));if(!basis){reasons.push(`Recorded criteria context for ${linked.type} ${linked.id} is unknown; no criteria change is inferred.`);continue;}if(basis.hash!==await criteriaHash(linked,snapshot.requirements))reasons.push(`Recorded criteria context for ${linked.type} ${linked.id} differs from current criteria; inspect this exact decision version.`);}
  if(!reasons.length)continue;
  reasons.push(decision.status==='draft'?'This is a draft, not a recorded decision or execution authorization.':'Recorded choice and criteria basis are historical context; they do not establish current owner authority or execute an action.');
  const subject=decision.subjects.length===1?decision.subjects[0]:undefined;const projects=[...new Set(decision.subjects.map(project).filter((p):p is string=>p!==null))];items.push({id:`decision:${decision.id}:${decision.version}`,kind:'decision-review',...(subject?{subject}:{}),projectId:projects.length===1?projects[0]:null,title:`Review decision: ${decision.title}`,reasons:[...new Set(reasons)],href:reviewHref({kind:'decision',id:decision.id,version:decision.version})});
 }

 if(items.length>10000||new TextEncoder().encode(canonical(items)).length>8_000_000)throw new Error('Review attention output exceeds bounded limit.');return items;
}
