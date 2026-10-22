import {nativeCompletedTaskIds} from './native-task-completion.ts';
import type {PrivateHistoryBucket} from './object-store.ts';
import {loadHistoryAnalysisInput} from './analysis-input.ts';
import {readNativeHistoryClaims} from './native-claims.ts';
import type {ValidatedHistoryClaim} from './claims.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {ownerReader} from '../workspace-modules.ts';
import {readOperationalWatermarks} from '../operational-watermarks.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {parseHistoryRecord,type HistoryRecord} from './record.ts';
import {getRoadmapState} from './roadmap-store.ts';
import {buildAreaProgress} from './progress.ts';
import {projectHistoryCoverage} from './coverage.ts';
import {resolveAssociation} from './association.ts';
import {historyInputWatermark} from './input-watermark.ts';
import {HistoryOverviewSchema,type HistoryOverview} from './overview-contract.ts';
/** Bounded signed-in owner projection. Bracket both editor and operational heads;
 * a concurrent import/analysis never becomes an apparently coherent snapshot. */
export async function readHistoryOverview(db:SqlDatabase,owner:string,now:string,bucket?:PrivateHistoryBucket):Promise<HistoryOverview>{
 if(!owner)throw Error('Authenticated history owner required.');
 for(let attempt=0;attempt<2;attempt++){
  const before=await readCurrent(db,owner,now),watermarks=await readOperationalWatermarks(db,owner),query=ownerReader(db,owner),records:HistoryRecord[]=[],physical=new Map<string,{revision:number;hash:string}>();let after='',bytes=0;
  for(;;){const page=await query.list('project_history',{after,limit:200});for(const row of page){bytes+=new TextEncoder().encode(row.payload_json).length;if(records.length>=10000||bytes>8*1024*1024)throw Error('History overview exceeds bounded metadata capacity.');const record=parseHistoryRecord(JSON.parse(row.payload_json));if(record.id!==row.id||await contentHash(canonical(record))!==row.content_hash)throw Error('History record integrity differs.');records.push(record);physical.set(row.id,{revision:row.row_revision,hash:row.content_hash});after=row.id;}if(page.length<200)break;}
  const trust=async(id:string,hash:string)=>!!await db.prepare('SELECT 1 FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').bind(owner,id,hash).first();
  const sources=records.filter(r=>r.kind==='source'),conversations=records.filter(r=>r.kind==='conversation').map(r=>r.value),messages=records.filter(r=>r.kind==='message').map(r=>r.value),segments=records.filter(r=>r.kind==='segment').map(r=>r.value),attachments=records.filter(r=>r.kind==='attachment').map(r=>r.value),gaps=records.filter(r=>r.kind==='gap').map(r=>r.value),memberships=records.filter(r=>r.kind==='inventory_membership').map(r=>r.value),workItems=records.filter(r=>r.kind==='work_item').map(r=>r.value),claims=records.filter(r=>r.kind==='claim').map(r=>r.value);
  const associationRules=await Promise.all(records.filter((r):r is HistoryRecord<'association_rule'>=>r.kind==='association_rule').map(async record=>({value:record.value,rowRevision:physical.get(record.id)!.revision,trusted:await trust(record.id,physical.get(record.id)!.hash)})));
  const trustedRuleIds=new Set(associationRules.filter(rule=>rule.trusted).map(rule=>rule.value.id));
  const unassignedConversations=conversations.filter(conversation=>{const result=resolveAssociation({workspace:before.workspace,context:{sourceId:conversation.sourceId,conversationId:conversation.id,messageRevisionId:'overview-no-message-context',repositoryIdentity:conversation.repositoryIdentity,branch:conversation.branch,commit:null,basis:'provider_metadata'},ownerRules:associationRules.map(rule=>rule.value).filter(rule=>rule.scope!=='messages'),trustRule:rule=>trustedRuleIds.has(rule.id)});return result.projectId===null;}).map(({id,sourceId,title,nativeThreadId})=>({id,sourceId,title,nativeThreadId}));
  const sourceWatermark=await historyInputWatermark(records),progress:HistoryOverview['progress']=[],scopes:HistoryOverview['scopes']=[];
  let validatedClaims:ValidatedHistoryClaim[]=[];const semanticUnknowns:string[]=[];
  if(claims.length){if(bucket){try{const sourceIds=sources.filter(source=>source.value.removedAt===null).map(source=>source.value.id);if(sourceIds.length){const loaded=await loadHistoryAnalysisInput(db,owner,{sourceIds,bucket,now});if(loaded.historyInputWatermark!==sourceWatermark)continue;validatedClaims=await readNativeHistoryClaims(db,owner,loaded);semanticUnknowns.push(...loaded.unknowns);}}catch{semanticUnknowns.push('Retained semantic evidence could not be validated at the current source boundary.');}}else semanticUnknowns.push('Private evidence storage is required to validate retained observations.');}
  const acceptedTaskIds=await nativeCompletedTaskIds(db,owner,before.workspace);
  const currentClaimIds=new Set(validatedClaims.map(row=>row.claim.id));
  const stories=records.filter(r=>r.kind==='story').map(r=>r.value).sort((a,b)=>b.planningRevision-a.planningRevision||b.generatedAt.localeCompare(a.generatedAt)||b.id.localeCompare(a.id)).filter((story,i,all)=>all.findIndex(row=>row.projectId===story.projectId&&row.areaId===story.areaId)===i);
  for(const story of stories){const kept=[];for(const entry of story.finished){if(entry.basis!=='accepted'){if(story.sourceWatermark===sourceWatermark&&entry.claimIds.length&&entry.claimIds.every(id=>currentClaimIds.has(id)))kept.push(entry);else story.unknowns=[...story.unknowns,'A retained observation awaits current native semantic evidence; its proposal remains in retained history.'];continue;}const assessment=records.find(r=>r.kind==='checkpoint_assessment'&&r.value.id===entry.acceptanceRef);let current=false;
   if(assessment?.kind==='checkpoint_assessment'&&assessment.value.verdict==='accepted'&&await trust(assessment.id,physical.get(assessment.id)!.hash)){
    const state=await getRoadmapState(query,assessment.value.scopeId,trust),latest=state.assessments.filter(row=>row.checkpointId===assessment.value.checkpointId).sort((a,b)=>a.id.localeCompare(b.id)).at(-1);
    current=!!state.agreed&&state.scope?.projectId===story.projectId&&state.scope?.areaId===story.areaId&&state.scope?.revision===assessment.value.scopeRevision&&latest?.id===assessment.value.id;
   }
   if(current)kept.push(entry);else story.unknowns=[...story.unknowns,'A retained acceptance claim has no current owner grant in this area; inspect its historical evidence.'];}story.finished=kept;}
  for(const head of records.filter(r=>r.kind==='roadmap_head')){
   const state=await getRoadmapState(query,head.value.id,trust);if(!state.scope)continue;scopes.push({...state.scope,agreedAt:state.agreed?state.scope.agreedAt:null});
   // Stored claims are proposals. Semantic support is not fabricated during a
   // GET. Native owner acceptance still resolves independently through grants.
   progress.push(await buildAreaProgress({ownerId:owner,projectId:head.value.projectId,areaId:head.value.areaId,planningRevision:before.revision,sourceWatermark,workspace:before.workspace,items:workItems,claims:validatedClaims,scope:state.scope,assessments:state.assessments,coverageComplete:false,unknowns:[...semanticUnknowns,'Source coverage requires its own verified acquisition checkpoint.'],trustAgreement:async()=>state.agreed,trustAssessment:async assessment=>state.assessments.some(row=>row.id===assessment.id),trustTaskCompletion:async id=>acceptedTaskIds.has(id),checkpointEvidence:checkpointId=>{const assessment=state.assessments.filter(row=>row.checkpointId===checkpointId).sort((a,b)=>a.id.localeCompare(b.id)).at(-1);const related=validatedClaims.filter(row=>assessment?.claimIds.includes(row.claim.id)&&row.claim.projectId===head.value.projectId&&row.claim.areaId===head.value.areaId&&row.claim.basis==='observed');const released=related.filter(row=>row.claim.kind==='release'),verified=related.filter(row=>row.claim.kind==='verification'),implemented=related.filter(row=>row.completionSupported&&row.claim.kind==='implementation');const selected=released.length?released:verified.length?verified:implemented;return {stage:released.length?'released':verified.length?'verified':implemented.length?'implemented':'unknown',claimIds:selected.map(row=>row.claim.id)};}}));
  }
  const statuses=sources.map(source=>{
   const value=source.value,runs=records.filter((r):r is HistoryRecord<'sync_run'>=>r.kind==='sync_run'&&r.value.sourceId===value.id&&r.value.epoch===value.epoch&&r.value.scopeRevision===value.scopeRevision);
   const candidates=runs.flatMap(run=>{const acknowledgement=records.find(r=>r.kind==='ingest_page'&&r.value.acknowledgement.sourceId===value.id&&r.value.acknowledgement.epoch===value.epoch&&r.value.acknowledgement.scopeRevision===value.scopeRevision&&r.value.acknowledgement.pageId===run.value.lastPageId);return acknowledgement?.kind==='ingest_page'&&memberships.some(m=>m.sourceId===value.id&&m.epoch===value.epoch&&m.scopeRevision===value.scopeRevision&&m.generation===acknowledgement.value.runId)?[{value:run.value,generation:acknowledgement.value.runId}]:[];});
   const inventory=candidates.sort((a,b)=>b.value.watermark-a.value.watermark)[0];
   // No content-sweep/physical-lineage proof is inferred from a heartbeat or
   // terminal transport cursor. Durable runner completion supplies it later.
   const coverage=projectHistoryCoverage({ownerId:owner,scope:value.configuration,generation:inventory?.generation??'unverified',capability:value.capability,memberships,conversations,messages,segments,attachments,gaps,verifiedSegments:[],contentSweptConversationIds:[],inventoryExhausted:inventory?.value.inventoryExhausted??false,lastInventorySuccessAt:inventory?.value.inventoryExhausted?inventory.value.updatedAt:null,lastContentSuccessAt:null,freshness:{now,maxLagMs:10*60*1000,allowedClockSkewMs:60000,running:false,offline:false,failure:null,heartbeatAt:null,lastAttemptAt:inventory?.value.updatedAt??null,nextDueAt:null,oldestPendingAt:null,continuation:null}}).snapshot;
   return {capability:value.capability,coverage,gaps:gaps.filter(gap=>gap.sourceId===value.id),paused:value.paused,connected:!value.removedAt,analysisAt:null,analysisWatermark:null};
  });
  const current=await readCurrent(db,owner,now),currentWatermarks=await readOperationalWatermarks(db,owner);if(current.revision!==before.revision||canonical(currentWatermarks)!==canonical(watermarks))continue;
  return HistoryOverviewSchema.parse({planningRevision:before.revision,sourceWatermark,progress,stories,scopes,workItems,claims,unassignedConversations,associationRules,unassignedHistoryCount:unassignedConversations.length,sources:statuses,configurations:sources.map(source=>({sourceId:source.value.id,rowRevision:physical.get(source.id)!.revision,scopeLabel:source.value.capability.scopeLabel,configuration:source.value.configuration,paused:source.value.paused,removedAt:source.value.removedAt}))});
 }
 throw Error('History changed while reading. Retry the projection.');
}
