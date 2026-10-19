import {canonical,contentHash} from '../canonical-json.ts';
import {canonicalJsonValue,parseAuditEvent} from '../audit-events.ts';
import {parseWorkspaceExport} from '../workspace-validation.ts';
import {evidenceDateSchema,evidenceVersionSchema,evidenceLinkSchema} from '../evidence-validation.ts';
import {decisionVersionSchema} from '../decisions.ts';
import {sourceObservationSchema,sourceTargetSchema} from '../sources/validation.ts';
import {cairoDate} from '../calendar.ts';
import {archivedEntity,entityHref} from '../entity-links.ts';
import {getTaskGraphBlockers,taskGraphFulfilled} from '../task-graph.ts';
import {frozenAuditRecordSchema,operationalWatermarksSchema,reviewScopeSchema,reviewSnapshotSchema} from './validation.ts';
import {REVIEW_LIMITS,type FrozenPlanningRecord,type PlanningSnapshotRef,type ReviewAssemblyInput,type ReviewFact,type ReviewSnapshot,type ReviewEntityKind} from './contracts.ts';
import {reviewSourceFreshness,reviewSourceWatermark} from './freshness.ts';
import type {JsonValue} from '../workspace-protocol.ts';
const sort=<T>(values:T[],key:(value:T)=>string)=>values.toSorted((a,b)=>(key(a)<key(b)?-1:key(a)>key(b)?1:0));
const unique=<T>(values:T[],key:(value:T)=>string)=>{const seen=new Set<string>();for(const value of values){const id=key(value);if(seen.has(id))throw new Error('Duplicate review input identity.');seen.add(id);}return values;};
/** Pure bounded assembly. The authenticated caller supplies a coherent owner revision
 * and operational vector; this function creates no acceptance or execution authority. */
export async function assembleReview(raw:ReviewAssemblyInput):Promise<ReviewSnapshot>{
 const plain=canonicalJsonValue(raw);
 if(new TextEncoder().encode(canonical(plain)).length>REVIEW_LIMITS.assemblyBytes)throw new Error('Review assembly exceeds its 8 MiB input bound.');
 const input=structuredClone(raw),now=evidenceDateSchema.parse(input.now),workspace=parseWorkspaceExport(input.envelope.workspace),revision=input.envelope.revision;
 if(!Number.isSafeInteger(revision)||revision<1)throw new Error('Review requires a positive frozen workspace revision.');
 const scope=reviewScopeSchema.parse({projectIds:sort([...input.projectIds],value=>value),filterDigest:input.filterDigest}),watermarks=operationalWatermarksSchema.parse(input.operationalWatermarks);
 if(scope.projectIds.some(id=>!workspace.projects.some(value=>value.id===id)))throw new Error('Review project scope is unavailable.');
 const rowCount=workspace.projects.length+workspace.tasks.length+workspace.milestones.length+workspace.captures.length+input.observations.length+input.sourceTargets.length+input.sourceStates.length+input.evidence.length+input.evidenceLinks.length+input.decisions.length+input.assessments.length+input.auditRecords.length;
 if(rowCount>REVIEW_LIMITS.assemblyRows)throw new Error('Review assembly exceeds its 10000-row input bound.');
 const observations=unique(input.observations.map(value=>sourceObservationSchema.parse(value)),value=>value.id),targets=unique(input.sourceTargets.map(value=>sourceTargetSchema.parse(value)),value=>value.id),states=unique(input.sourceStates,value=>value.sourceId);
 const evidence=unique(input.evidence.map(value=>evidenceVersionSchema.parse(value)),value=>`${value.id}:${value.version}`),links=unique(input.evidenceLinks.map(value=>evidenceLinkSchema.parse(value)),value=>value.id),decisions=unique(input.decisions.map(value=>decisionVersionSchema.parse(value)),value=>`${value.id}:${value.version}`),audits=unique(input.auditRecords.map(value=>frozenAuditRecordSchema.parse(value)),value=>value.ref.eventId);
 for(const observation of observations)if(await contentHash(canonical(observation.payload))!==observation.contentDigest)throw new Error('Review source payload hash differs.');
 for(const audit of audits){if(await contentHash(canonical(audit.value))!==audit.ref.contentHash)throw new Error('Review audit payload hash differs.');if(audit.ref.workspaceRevision!==null?audit.ref.workspaceRevision>revision:audit.ref.sequence>(watermarks[audit.ref.streamId]??-1))throw new Error('Review audit exceeds the frozen boundary.');}
 const frozen=new Map<string,FrozenPlanningRecord>(),projectOf=new Map<string,string>(),unknowns=new Set<string>(),candidates:ReviewFact[]=[];
 function unknown(text:string){unknowns.add(text.slice(0,REVIEW_LIMITS.unknownCharacters));}
 if(input.historyTruncated)unknown('Audit history input is limited to the latest 1000 selected-project events; older events remain unreviewed.');
 for(const [kind,rows]of [['project',workspace.projects],['milestone',workspace.milestones],['task',workspace.tasks],['capture',workspace.captures]]as const){for(const row of rows){const projectId='projectId'in row?row.projectId:row.id;if(projectId)projectOf.set(`${kind}:${row.id}`,projectId);if(!projectId)continue;const value=canonicalJsonValue(row) as {[key:string]:JsonValue};frozen.set(`${kind}:${row.id}`,{kind,id:row.id,workspaceRevision:revision,contentHash:await contentHash(canonical(value)),value});}}
 function ref(kind:ReviewEntityKind,id:string):PlanningSnapshotRef{const row=frozen.get(`${kind}:${id}`);if(!row)throw new Error('Review planning provenance is unavailable.');const {value:_,...citation}=row;void _;return citation;}
 async function add(value:Omit<ReviewFact,'id'>){const fact={...value,id:`review_fact_${await contentHash(canonical({...value,planningRefs:value.planningRefs.map(({workspaceRevision:_,...ref})=>{void _;return ref;})}))}`};if(!candidates.some(row=>row.id===fact.id))candidates.push(fact);}
 const base=(projectId:string,kind:ReviewEntityKind,id:string)=>({projectId,evidenceRefs:[],decisionRefs:[],observationRefs:[],planningRefs:[ref(kind,id)],auditRefs:[],observedAt:null,sourceUpdatedAt:null,basis:'documented' as const,href:entityHref({kind,id})});
 for(const project of sort(workspace.projects.filter(row=>scope.projectIds.includes(row.id)),row=>row.id)){
  await add({...base(project.id,'project',project.id),kind:'progress',text:`Recorded project: ${project.name}${project.archivedAt?' (archived)':''}. ${project.goal}`});
  if(!input.assessments.some(value=>projectOf.get(`${value.subject.type}:${value.subject.id}`)===project.id))unknown(`${project.name}: no current evidence acceptance assessment was supplied; acceptance is unknown.`);
 }
 for(const task of sort(workspace.tasks.filter(row=>scope.projectIds.includes(row.projectId)),row=>row.id)){
  const context=base(task.projectId,'task',task.id),fulfilled=taskGraphFulfilled(task),archived=archivedEntity(workspace,{kind:'task',id:task.id});
  const blockers=getTaskGraphBlockers(workspace,task.id);
  if(blockers.length&&!fulfilled&&!archived){for(const blocker of blockers)await add({...context,kind:'blocker',text:`Recorded blocker for “${task.title}”: ${blocker.message}`,planningRefs:[context.planningRefs[0],...(blocker.prerequisiteId?[ref('task',blocker.prerequisiteId)]:[])]});}
  else await add({...context,kind:'progress',text:fulfilled?`Planning record marks “${task.title}” completed. This records task state and does not establish independent acceptance or operational results.`:archived?`Planning record “${task.title}” is archived; no new action is recommended.`:task.status==='proposed'?`Proposed work “${task.title}” awaits explicit owner acceptance; it is not a commitment.`:`Eligible next action under the recorded task prerequisites: “${task.title}” (${task.status}). Ranking does not change project importance or authorize execution.`,observedAt:fulfilled?task.completedAt:null});
  if(fulfilled&&!task.completedAt)unknown(`Task ${task.id}: original completion date is unknown.`);
  if(task.dueDate&&!fulfilled&&!archived)await add({...context,kind:'deadline',text:`Recorded due date for “${task.title}”: ${task.dueDate}${task.dueDate<cairoDate(now)?' (overdue in Africa/Cairo)':''}.`});
 }
 for(const milestone of sort(workspace.milestones.filter(row=>scope.projectIds.includes(row.projectId)),row=>row.id)){
  const context=base(milestone.projectId,'milestone',milestone.id);
  await add({...context,kind:'progress',text:`Milestone record “${milestone.title}” is ${milestone.status}${milestone.archivedAt?' and archived':''}; recorded state alone does not establish acceptance.`});
  if(milestone.targetDate&&!archivedEntity(workspace,{kind:'milestone',id:milestone.id})&&milestone.status!=='achieved')await add({...context,kind:'deadline',text:`Recorded milestone target for “${milestone.title}”: ${milestone.targetDate}${milestone.targetDate<cairoDate(now)?' (overdue in Africa/Cairo)':''}.`});
 }
 for(const capture of sort(workspace.captures.filter(row=>row.projectId&&scope.projectIds.includes(row.projectId)&&row.kind==='decision'&&row.status==='inbox'),row=>row.id))await add({...base(capture.projectId!,'capture',capture.id),kind:'decision',text:`Decision capture awaiting owner review: “${capture.title}”. Captured text does not authorize execution.`,observedAt:capture.createdAt});
 for(const link of sort(links,row=>row.id)){
  const projectId=projectOf.get(`${link.subject.type}:${link.subject.id}`);if(!projectId||!scope.projectIds.includes(projectId))continue;
  const version=evidence.find(value=>value.id===link.evidenceId&&value.version===link.evidenceVersion);if(!version){unknown(`Evidence link ${link.id}: exact version ${link.evidenceId}:${link.evidenceVersion} is unavailable.`);continue;}
  const observation=version.sourceObservationRef?observations.find(value=>value.id===version.sourceObservationRef!.id&&value.contentDigest===version.sourceObservationRef!.contentDigest):undefined;
  if(version.sourceObservationRef&&!observation){unknown(`Evidence ${version.id}:${version.version}: exact source observation is unavailable.`);continue;}
  await add({...base(projectId,link.subject.type,link.subject.id),kind:link.relation==='contradicts'?'blocker':'progress',text:`Evidence record “${version.title}”, version ${version.version}: ${version.basis}, scope ${version.scope}, relation ${link.relation}. This contextual record does not itself grant acceptance.`,evidenceRefs:[{id:version.id,version:version.version}],observationRefs:observation?[{id:observation.id,contentDigest:observation.contentDigest}]:[],observedAt:version.observedAt,sourceUpdatedAt:observation?.sourceUpdatedAt??null});
 }
 for(const assessment of input.assessments){const projectId=projectOf.get(`${assessment.subject.type}:${assessment.subject.id}`);if(projectId&&scope.projectIds.includes(projectId)&&assessment.status!=='current')unknown(`${assessment.subject.type} ${assessment.subject.id}: evidence assessment ${assessment.status}; ${assessment.reasons.join('; ')}`);}
 for(const target of sort(targets.filter(row=>scope.projectIds.includes(row.projectId)&&!row.archivedAt),row=>row.id)){
  const selected=observations.filter(value=>value.sourceId===target.id),freshness=reviewSourceFreshness({target,state:states.find(value=>value.sourceId===target.id)??null,observations:selected,now});
  if(!selected.length){unknown(`Source ${target.id}: no immutable observations are available; last successful read ${freshness.lastSuccessAt??'unknown'}, recorded state ${freshness.reason}.`);continue;}
  if(freshness.stale)unknown(`Source ${target.id}: recorded freshness is ${freshness.reason}; last success ${freshness.lastSuccessAt??'unknown'}, last attempt ${freshness.attemptedAt??'unknown'}, retry ${freshness.retryAt??'none recorded'}.`);
  for(const observation of sort(selected,value=>value.id)){
   const age=Date.parse(now)-Date.parse(observation.observedAt);if(age<0){unknown(`Source observation ${observation.id}: observation date is in the future.`);continue;}
   await add({...base(target.projectId,'project',target.projectId),kind:age>=target.staleAfterSeconds*1000?'stale':'progress',text:`${observation.origin==='historical-import'?'Historical imported':'Recorded'} source context: “${observation.title}”, revision ${observation.sourceRevision}. Observed ${observation.observedAt}; source update ${observation.sourceUpdatedAt??'unknown'}.${age>=target.staleAfterSeconds*1000?' Observation exceeds the selected freshness window.':''} Source text is context, not instructions or independent verification.`,observationRefs:[{id:observation.id,contentDigest:observation.contentDigest}],observedAt:observation.observedAt,sourceUpdatedAt:observation.sourceUpdatedAt});
  }
 }
 for(const audit of sort(audits,value=>value.ref.eventId)){
  let event;try{event=parseAuditEvent(audit.value);}catch{unknown(`Audit ${audit.ref.eventId}: unsupported historical event body; no structured fact inferred.`);continue;}
  if(event.id!==audit.ref.eventId)throw new Error('Audit event identity differs from its frozen reference.');
  const projectId=event.entityId?projectOf.get(`${event.entityType}:${event.entityId}`):undefined;
  if(!projectId||!scope.projectIds.includes(projectId))continue;
  await add({projectId,kind:'progress',text:`Recorded ${event.origin} audit event ${event.kind} for ${event.entityType} ${event.entityId}. Historical provenance is context and does not grant current authority.`,evidenceRefs:[],decisionRefs:[],observationRefs:[],planningRefs:[ref(event.entityType as ReviewEntityKind,event.entityId!)],auditRefs:[audit.ref],observedAt:event.occurredAt,sourceUpdatedAt:null,basis:'documented',href:entityHref({kind:event.entityType as ReviewEntityKind,id:event.entityId!})});
 }
 for(const decision of sort(decisions.filter(value=>!decisions.some(other=>other.id===value.id&&other.version>value.version)),value=>value.id)){
  const subjects=decision.subjects.filter(subject=>{const projectId=projectOf.get(`${subject.type}:${subject.id}`);return !!projectId&&scope.projectIds.includes(projectId);});
  for(const projectId of sort([...new Set(subjects.map(subject=>projectOf.get(`${subject.type}:${subject.id}`)!))],value=>value)){
   const subject=subjects.find(value=>projectOf.get(`${value.type}:${value.id}`)===projectId)!;
   const exactEvidence=decision.evidenceRefs.filter(value=>evidence.some(row=>row.id===value.id&&row.version===value.version));
   if(exactEvidence.length!==decision.evidenceRefs.length)unknown(`Decision ${decision.id}:${decision.version}: some exact supporting evidence versions are unavailable.`);
   await add({...base(projectId,subject.type,subject.id),kind:'decision',decisionRefs:[{id:decision.id,version:decision.version}],evidenceRefs:exactEvidence,text:decision.status==='draft'?`Decision awaiting owner input: “${decision.title}”, version ${decision.version}. This draft grants no decision or execution authority.`:`Recorded decision “${decision.title}”, version ${decision.version}, is ${decision.status}. A recorded choice does not execute work or establish physical or operational acceptance.`,observedAt:decision.decidedAt});
  }
 }
 // Round-robin projects before enforcing output capacity; no project receives an implicit priority.
 const queues=scope.projectIds.map(id=>sort(candidates.filter(value=>value.projectId===id),value=>`${value.kind}:${value.id}`)),ordered:ReviewFact[]=[];
 for(let index=0;queues.some(values=>index<values.length);index++)for(const values of queues)if(values[index])ordered.push(values[index]);
 const selectedFacts:ReviewFact[]=[],selectedPlanning=new Map<string,FrozenPlanningRecord>(),selectedAudits=new Map<string,typeof audits[number]>();
 const allUnknowns=sort([...unknowns],value=>value),keptUnknowns=allUnknowns.slice(0,REVIEW_LIMITS.unknowns);
 if(allUnknowns.length>keptUnknowns.length)keptUnknowns[keptUnknowns.length-1]=`${allUnknowns.length-keptUnknowns.length+1} additional unknown diagnostics omitted by the review bound; no omitted facts or events are acknowledged.`;
 const bytes=(value:unknown)=>new TextEncoder().encode(canonical(value)).length;
 let estimatedBytes=16_384+bytes(keptUnknowns)+bytes(scope)+bytes(watermarks);
 const countedDecisions=new Set<string>(),countedSources=new Set<string>();
 async function materialize():Promise<ReviewSnapshot>{const sourceSet=sort([...new Map(selectedFacts.flatMap(value=>value.observationRefs).map(value=>[value.id,value])).values()],value=>value.id);const content={sourceStateBoundary:sort(targets.filter(target=>scope.projectIds.includes(target.projectId)).map(target=>({sourceId:target.id,operationalRevision:states.find(state=>state.sourceId===target.id)?.operationalRevision??null})),value=>value.sourceId),scope,workspaceRevision:revision,operationalWatermarks:watermarks,sourceWatermark:await reviewSourceWatermark(sourceSet),sourceSet,facts:[...selectedFacts],unknowns:keptUnknowns,decisionVersions:sort([...new Map(selectedFacts.flatMap(value=>value.decisionRefs).map(value=>[`${value.id}:${value.version}`,decisions.find(row=>row.id===value.id&&row.version===value.version)!])).values()],value=>`${value.id}:${value.version}`),planningRecords:sort([...selectedPlanning.values()],value=>`${value.kind}:${value.id}`),auditRecords:sort([...selectedAudits.values()],value=>value.ref.eventId),coverage:{complete:!input.historyTruncated&&selectedFacts.length===ordered.length,remainingFacts:ordered.length-selectedFacts.length+(input.historyTruncated?1:0),includedFactIds:selectedFacts.map(value=>value.id),includedEventIds:sort([...selectedAudits.keys()],value=>value)},modelRunId:null};return {...content,generatedAt:now,id:`review_${await contentHash(canonical(content))}`};}
 for(const fact of ordered){
  if(selectedFacts.length>=REVIEW_LIMITS.facts)break;
  const newPlanning=fact.planningRefs.filter(value=>!selectedPlanning.has(`${value.kind}:${value.id}`)),newAudits=fact.auditRefs.filter(value=>!selectedAudits.has(value.eventId));
  if(selectedPlanning.size+newPlanning.length>REVIEW_LIMITS.planningRecords||selectedAudits.size+newAudits.length>REVIEW_LIMITS.auditRecords)break;
  const newDecisions=fact.decisionRefs.filter(value=>!countedDecisions.has(`${value.id}:${value.version}`)),newSources=fact.observationRefs.filter(value=>!countedSources.has(value.id));
  const addedBytes=bytes(fact)+bytes(fact.id)+20+newPlanning.reduce((sum,value)=>sum+bytes(frozen.get(`${value.kind}:${value.id}`)!)+10,0)+newAudits.reduce((sum,value)=>sum+bytes(audits.find(row=>row.ref.eventId===value.eventId)!)+bytes(value.eventId)+20,0)+newDecisions.reduce((sum,value)=>sum+bytes(decisions.find(row=>row.id===value.id&&row.version===value.version)!)+10,0)+newSources.reduce((sum,value)=>sum+bytes(value)+10,0);
  if(estimatedBytes+addedBytes>REVIEW_LIMITS.snapshotBytes)break;
  estimatedBytes+=addedBytes;
  selectedFacts.push(fact);for(const value of newPlanning)selectedPlanning.set(`${value.kind}:${value.id}`,frozen.get(`${value.kind}:${value.id}`)!);for(const value of newAudits)selectedAudits.set(value.eventId,audits.find(row=>row.ref.eventId===value.eventId)!);for(const value of newDecisions)countedDecisions.add(`${value.id}:${value.version}`);for(const value of newSources)countedSources.add(value.id);
 }
 const snapshot=await materialize();return reviewSnapshotSchema.parse(snapshot);
}
