import type {SqlDatabase} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {ownerReader} from '../workspace-modules.ts';
import {loadHistoryAnalysisInput,type LoadedHistoryAnalysisInput} from './analysis-input.ts';
import {planAnalysis,runAnalysis,type AnalysisChunk,type AnalysisConsent,type AnalysisRunInput,type AnalysisOperationProposal,type HistoryAnalysisAdapter} from './analysis.ts';
import {readAreaAnalysisJob,adoptAreaAnalysisJob,rebaseAreaAnalysisJob,claimAreaAnalysisJob,isAreaAnalysisClaimCurrent,finishAreaAnalysisJob,appendAreaAnalysisReservation,prepareAreaAnalysisProgress,type AreaAnalysisAuthority,type AreaAnalysisJob,type AnalysisJobPin} from './analysis-job-store.ts';
import {describeHistoryAnalysisScope,reserveHistoryAnalysis,prepareHistoryAnalysisCompletion} from './analysis-journal.ts';
import {publishHistoryProjection} from './publication.ts';
import {runHistoryRemovalProjection} from './removal-projection.ts';
import {readNativeHistoryClaims} from './native-claims.ts';
import {readHistoryRecord} from './store.ts';
import {reconcileWorkItems,type WorkItemOperation} from './work-items.ts';
import {buildAreaStory} from './story.ts';
import type {ValidatedHistoryClaim} from './claims.ts';
import type {AnalysisCheckpoint,HistoryWorkItem} from './contracts.ts';
export interface AreaAnalysisAttemptOptions {
 bucket:Parameters<typeof loadHistoryAnalysisInput>[2]['bucket'];authority:AreaAnalysisAuthority;now:string;currentTime?:()=>string;signal?:AbortSignal;
 adapter?:HistoryAnalysisAdapter|null;verifySupport?:AnalysisRunInput['verifySupport'];consent?:AnalysisConsent|null;
 operationScopeMatches?:(item:HistoryWorkItem,claims:readonly ValidatedHistoryClaim[],operation:Readonly<AnalysisOperationProposal>)=>boolean|Promise<boolean>;
 quoteUpperBound?:(input:{provider:string;model:string;chunk:AnalysisChunk})=>number;
}
export interface AreaAnalysisAttemptResult {operationProposals:AnalysisOperationProposal[];status:'not_configured'|'unavailable'|'published'|'complete'|'conflict';checkpoint:AnalysisCheckpoint|null;unknowns:string[];requestId:string|null;cursor:string|null}
const semanticKinds=['source','conversation','message','segment','attachment','gap','alias','repository_evidence','association_rule','source_removal'];
async function pinFor(input:LoadedHistoryAnalysisInput):Promise<AnalysisJobPin>{return {watermark:input.historyInputWatermark,inputDigest:await contentHash(canonical({watermark:input.historyInputWatermark,planningRevision:input.planningRevision,executionEpoch:input.executionEpoch,sourceRefs:input.sourceRefs,associations:input.snapshot.associations}))};}
function fencedAuthority(db:SqlDatabase,owner:string,authority:AreaAnalysisAuthority,input:LoadedHistoryAnalysisInput,pin:AnalysisJobPin):AreaAnalysisAuthority{
 const expected=input.rowProofs.filter(row=>semanticKinds.includes(row.physicalId.split(':')[0])),payload=canonical(expected);
 return {...authority,async pinGuardAt(candidate,now){
  if(canonical(candidate)!==canonical(pin))return null;const native=await authority.pinGuardAt(candidate,now);if(!native)return null;
  const sql=`(${native.sql}) AND EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?) AND COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN project_history actual ON actual.user_id=? AND actual.id=json_extract(expected.value,'$.physicalId') WHERE actual.id IS NULL OR actual.row_revision<>json_extract(expected.value,'$.rowRevision') OR actual.content_hash<>json_extract(expected.value,'$.contentHash')) AND (SELECT COUNT(*) FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind') IN (${semanticKinds.map(()=>'?').join(',')}))=?`;
  return {sql,bindings:[...native.bindings,owner,input.planningRevision,owner,input.executionEpoch,payload,owner,owner,...semanticKinds,expected.length]};
 }};
}
function checkpointFor(input:LoadedHistoryAnalysisInput,digest:string,state:AnalysisCheckpoint['state']):AnalysisCheckpoint{return {id:'analysis:'+digest,inputDigest:digest,sourceWatermark:input.historyInputWatermark,normalizationVersion:'unavailable',extractorVersion:'history-extractor-v1',processedMessageRevisionIds:[],processedSegmentIds:[],affectedAreaIds:[],state};}
/** One bounded native attempt. Dependencies are server ports; no authority,
 * adapter, semantic verifier or paid consent is obtained from job/model JSON. */
export async function runAreaAnalysisAttempt(db:SqlDatabase,owner:string,intentId:string,options:AreaAnalysisAttemptOptions):Promise<AreaAnalysisAttemptResult>{
 const result=(status:AreaAnalysisAttemptResult['status'],unknowns:string[],checkpoint:AnalysisCheckpoint|null=null,requestId:string|null=null,cursor:string|null=null,operationProposals:AnalysisOperationProposal[]=[]):AreaAnalysisAttemptResult=>({operationProposals,status,unknowns:[...new Set(unknowns)],checkpoint,requestId,cursor});
 let lastTime=Date.parse(options.now);
 const currentTime=()=>{const value=options.currentTime?.()??options.now,parsed=Date.parse(value);if(!Number.isFinite(parsed)||parsed<lastTime)throw Error('Invalid or regressing native analysis clock');lastTime=parsed;return value;};
 const deadline=AbortSignal.timeout(20000),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
 if(!options.authority||options.authority.ownerId!==owner||!Number.isFinite(Date.parse(options.authority.verifiedAt))||!Number.isFinite(Date.parse(options.authority.expiresAt))||Date.parse(options.authority.verifiedAt)>Date.parse(currentTime())||Date.parse(options.authority.expiresAt)<=Date.parse(currentTime())||!Number.isFinite(Date.parse(currentTime())))return result('unavailable',['Native analysis controller authority is unavailable.']);
 const access=await options.authority.guardAt(currentTime());if(!access||!await db.prepare('SELECT 1 WHERE '+access.sql).bind(...access.bindings).first())return result('unavailable',['Native analysis controller authority is unavailable.']);
 let job=await readAreaAnalysisJob(db,owner,intentId);if(!job)return result('unavailable',['Native analysis job is unavailable.']);
 if('removalId'in job.original){const removed=await runHistoryRemovalProjection(db,job,{authority:options.authority,now:currentTime(),currentTime});return result(removed.status==='removal_reprojected'?(removed.publicationId?'published':'complete'):removed.status==='continued'?'published':removed.status,['Removed source projections use retained metadata only; no inference was performed.']);}
 const sourceIds='sourceIds'in job.original?[...job.original.sourceIds]:[job.original.sourceId];
 let input:LoadedHistoryAnalysisInput;
 try{input=await loadHistoryAnalysisInput(db,owner,{sourceIds,bucket:options.bucket,now:currentTime()});}catch{return result('conflict',['Pinned private history input is unavailable or changed.']);}
 signal.throwIfAborted();const pin=await pinFor(input),authority=fencedAuthority(db,owner,options.authority,input,pin);
 if(job.status==='succeeded')return result('complete',input.unknowns);
 if(job.control&&canonical(job.control.pin)!==canonical(pin)){job=await rebaseAreaAnalysisJob(db,owner,intentId,{authority,pin,now:currentTime()});if(!job)return result('conflict',['Analysis job has live or changed original source fences; stale input cannot be rebased.']);}
 if(!job.control)job=await adoptAreaAnalysisJob(db,owner,intentId,{authority,pin,now:currentTime()});if(!job)return result('conflict',['Analysis job pin or original source fences changed.']);
 job=await claimAreaAnalysisJob(db,owner,intentId,{authority,now:currentTime(),leaseMs:20000});if(!job)return result('conflict',['Analysis job lease is unavailable.']);
 let active:AreaAnalysisJob=job,requestId:string|null=null;
 const finish=async(outcome:'complete'|'continue'|'failed',cursor:string|null,failure:'access'|'stale_input'|'processing'|'timeout'='processing')=>{const at=currentTime();return finishAreaAnalysisJob(db,active,{authority,now:at,currentTime,outcome,cursor,reservedRequestIds:active.control!.reservedRequestIds,retryAt:new Date(Date.parse(at)+300000).toISOString(),failure});};
 try {
 const retainedItems:HistoryWorkItem[]=[];for(const expected of input.expectedRows)if(expected.kind==='work_item'){const retained=await readHistoryRecord(db,owner,'work_item',expected.logicalId);if(!retained||retained.rowRevision!==expected.rowRevision||retained.contentHash!==expected.contentHash)return result('conflict',['Retained work context changed.']);retainedItems.push(retained.record.value);}
 const selectedClaimIds=new Set(input.retainedClaims.map(claim=>claim.id));
 const targets=[...new Map(input.snapshot.associations.map(association=>[canonical([association.projectId,association.areaId]),{projectId:association.projectId,areaId:association.areaId}])).values()].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 let selected:{target:typeof targets[number];chunk:AnalysisChunk}|null=null;
 for(const target of targets){signal.throwIfAborted();const ids=new Set(input.snapshot.associations.filter(a=>a.projectId===target.projectId&&a.areaId===target.areaId).map(a=>a.messageRevisionId)),snapshot={...input.snapshot,messages:input.snapshot.messages.filter(m=>ids.has(m.message.id)),contexts:input.snapshot.contexts.filter(c=>ids.has(c.messageRevisionId)),associations:input.snapshot.associations.filter(a=>ids.has(a.messageRevisionId))};
  for(const version of [...new Set(snapshot.messages.map(m=>m.message.normalizationVersion))].sort()){signal.throwIfAborted();const plan=await planAnalysis(snapshot,input.segments,input.checkpoints,version,'history-extractor-v1',c=>input.trustedCheckpointIds.includes(c.id),{workItems:retainedItems.filter(item=>item.projectId===target.projectId&&item.areaId===target.areaId&&item.claimIds.length>0&&item.claimIds.every(id=>selectedClaimIds.has(id))).map(({id,title,state,workType,disposition,claimIds})=>({id,title,state,workType,disposition,claimIds})),trustedExtractionDigests:input.checkpointProofs.map(proof=>proof.extractionDigest)});if(plan.chunks.length){selected={target,chunk:plan.chunks[0]};break;}}if(selected)break;
 }
 if(!selected){const unknowns=[...input.unknowns,...(!targets.length?['Selected history has no native project association.']:[])];const finished=await finish(targets.length?'complete':'failed',targets.length?null:active.control!.cursor,'access');if(!finished)return result('conflict',[...unknowns,'Analysis job completion lost its current authority or pin.']);return result(targets.length?'complete':'unavailable',unknowns);}
 const {target,chunk}=selected,cursor=canonical([target,chunk.inputDigest]),configured=!!options.adapter&&!!options.verifySupport&&!!options.quoteUpperBound&&!!options.consent;
 if(!configured){await finish('failed',active.control!.cursor,'access');return result('not_configured',[...input.unknowns,'Exact provider, semantic verifier, renewable history consent and bounded quote are required.'],checkpointFor(input,chunk.inputDigest,'not_configured'),null,cursor);}
 let scope:Awaited<ReturnType<typeof describeHistoryAnalysisScope>>;
 try{scope=await describeHistoryAnalysisScope(ownerReader(db,owner),sourceIds,input.executionEpoch);}catch{await finish('failed',active.control!.cursor,'access');return result('not_configured',['Exact enabled native analysis policy is unavailable.'],checkpointFor(input,chunk.inputDigest,'not_configured'),null,cursor);}
 const liveAt=(at:string)=>Date.parse(authority.expiresAt)>Date.parse(at)&&!!active.control?.lease&&Date.parse(active.control.lease.expiresAt)>Date.parse(at)&&!!options.consent&&Date.parse(options.consent.expiresAt)>Date.parse(at);
 const nativeConsent=async(at:string)=>db.prepare("SELECT expires_at FROM review_analysis_consents WHERE user_id=? AND policy_hash=? AND provider=? AND model=? AND max_cost_micros=? AND revoked_at IS NULL AND julianday(created_at)<=julianday(?) AND julianday(expires_at)>julianday(?)").bind(owner,scope.scopeHash,scope.policy.provider!,scope.policy.model!,Math.ceil(scope.policy.maxCostDollars!*1000000),at,at).first<{expires_at:string}>();
 const currentAuthority=async()=>{const at=currentTime();if(!liveAt(at))return false;const consent=await nativeConsent(at),checked=currentTime();if(!consent||!liveAt(checked)||Date.parse(consent.expires_at)<=Date.parse(checked))return false;const owned=await isAreaAnalysisClaimCurrent(db,active,authority,checked),finished=currentTime();return owned&&liveAt(finished)&&Date.parse(consent.expires_at)>Date.parse(finished);};
 const boundedAdapter:HistoryAnalysisAdapter={provider:options.adapter!.provider,model:options.adapter!.model,async analyze(request){
  const at=currentTime(),consent=await nativeConsent(at);if(!consent||!await currentAuthority())throw Error('Analysis authority expired before provider dispatch');
  const dispatchAt=currentTime();if(!liveAt(dispatchAt)||Date.parse(consent.expires_at)<=Date.parse(dispatchAt))throw Error('Analysis authority expired at provider dispatch');
  const remaining=Math.min(20000,Date.parse(authority.expiresAt)-Date.parse(dispatchAt),Date.parse(active.control!.lease!.expiresAt)-Date.parse(dispatchAt),Date.parse(options.consent!.expiresAt)-Date.parse(dispatchAt),Date.parse(consent.expires_at)-Date.parse(dispatchAt));
  if(remaining<=0)throw Error('Analysis authority expiry deadline');
  const providerSignal=AbortSignal.any([request.signal,AbortSignal.timeout(remaining)]);
  let rejectAbort:()=>void=()=>{};const aborted=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(providerSignal.reason??Error('Analysis provider deadline'));providerSignal.addEventListener('abort',rejectAbort,{once:true});if(providerSignal.aborted)rejectAbort();});
  try{providerSignal.throwIfAborted();const output=await Promise.race([options.adapter!.analyze({...request,signal:providerSignal}),aborted]);const after=currentTime(),consentAfter=await nativeConsent(after),checked=currentTime();if(!liveAt(checked)||!consentAfter||Date.parse(consentAfter.expires_at)<=Date.parse(checked))throw Error('Analysis authority expired after provider response');return output;}finally{providerSignal.removeEventListener('abort',rejectAbort);}
 }};
 const proposal=await runAnalysis({chunk,policy:scope.policy,consent:options.consent!,adapter:boundedAdapter,verifySupport:options.verifySupport!,now:currentTime(),signal,reserve:async(inputDigest,policy)=>{
  if(!await currentAuthority())return 'budget_exhausted';signal.throwIfAborted();
  const quote=options.quoteUpperBound!({provider:policy.provider!,model:policy.model!,chunk});if(!Number.isFinite(quote)||quote<0||quote>policy.maxCostDollars!)return 'budget_exhausted';
  const reserved=await reserveHistoryAnalysis(db,owner,{sourceIds,privateSnapshotHash:chunk.privateSnapshotDigest,inputDigest,sourceWatermarkHash:await contentHash(input.historyInputWatermark),chunkHash:chunk.extractionDigest,inputBytes:new TextEncoder().encode(canonical(chunk.providerInput)).length,provider:policy.provider!,model:policy.model!,quoteUpperBoundDollars:quote,now:currentTime()});
  requestId=reserved.requestId;if(reserved.status!=='budget_exhausted'){const appended=await appendAreaAnalysisReservation(db,active,authority,currentTime(),reserved.requestId);if(!appended)return 'uncertain';active=appended;if(!await currentAuthority())return 'uncertain';}return reserved.status;
 }});
 if(proposal.checkpoint.state!=='complete'||!requestId||!proposal.usage){await finish('failed',active.control!.cursor,signal.aborted?'timeout':'processing');return result(proposal.checkpoint.state==='not_configured'?'not_configured':'unavailable',[...input.unknowns,...proposal.diagnostics],proposal.checkpoint,requestId,cursor);}
 signal.throwIfAborted();if(!await currentAuthority()){return result('conflict',['Analysis authority or source input changed before publication.'],proposal.checkpoint,requestId,cursor);}
 const prior=await readNativeHistoryClaims(db,owner,input),newIds=new Set(proposal.claims.map(c=>c.claim.id)),supporting=prior.filter(c=>!newIds.has(c.claim.id)&&c.claim.projectId===target.projectId&&c.claim.areaId===target.areaId),claims=[...supporting,...proposal.claims],claimIds=new Set(claims.map(c=>c.claim.id)),items:HistoryWorkItem[]=[],operations:WorkItemOperation[]=[],unknowns=[...input.unknowns];
 for(const expected of input.expectedRows)if(expected.kind==='work_item'){const row=await readHistoryRecord(db,owner,'work_item',expected.logicalId);if(row&&row.record.value.projectId===target.projectId&&row.record.value.areaId===target.areaId){if(row.record.value.claimIds.length>0&&row.record.value.claimIds.every(id=>claimIds.has(id)))items.push(row.record.value);else unknowns.push(`Retained work item ${row.record.value.id} awaits native evidence revalidation.`);}}
 for(const wrapper of proposal.claims){const requested=wrapper.claim.kind==='intent'&&wrapper.requestSupported,finished=wrapper.completionSupported&&['implementation','verification','release'].includes(wrapper.claim.kind)&&!proposal.operations.some(operation=>operation.claimIds.includes(wrapper.claim.id));if(!requested&&!finished)continue;const id='work:'+await contentHash(canonical([owner,target,wrapper.claim.id]));if(items.some(item=>item.id===id))continue;operations.push({operationId:'create:'+id,inputDigest:chunk.inputDigest,workItemId:id,kind:'create',claimIds:[wrapper.claim.id],newItem:{id,projectId:target.projectId,areaId:target.areaId,workType:'implementation',title:wrapper.claim.text,state:'open',disposition:requested?'requested':'idea',taskId:null,claimIds:[wrapper.claim.id],supersededById:null,rowRevision:1}});if(finished)operations.push({operationId:'finish:'+id,inputDigest:chunk.inputDigest,workItemId:id,kind:'observe-finished',claimIds:[wrapper.claim.id]});}
 const approvedOperationIds=new Set<string>();
 for(const proposed of proposal.operations){
  const item=items.find(item=>item.id===proposed.workItemId),cited=proposed.claimIds.map(id=>claims.find(wrapper=>wrapper.claim.id===id));
  const semantic=cited.every(wrapper=>!!wrapper)&&(proposed.kind==='observe-finished'?cited.some(wrapper=>wrapper!.completionSupported&&['implementation','verification','release'].includes(wrapper!.claim.kind)):proposed.kind==='cancel'?cited.some(wrapper=>wrapper!.claim.kind==='cancellation'):proposed.kind==='reopen'?cited.some(wrapper=>wrapper!.claim.kind==='intent'&&wrapper!.requestSupported):proposed.kind==='supersede'?cited.some(wrapper=>wrapper!.claim.kind==='supersession'):true);
  if(!item||!semantic||!options.operationScopeMatches||!await options.operationScopeMatches(structuredClone(item),cited as ValidatedHistoryClaim[],structuredClone(proposed))){unknowns.push(`Work operation ${proposed.kind} for ${proposed.workItemId} awaits independent cited scope verification.`);continue;}
  if(proposed.replacementId&&!items.some(replacement=>replacement.id===proposed.replacementId&&replacement.projectId===item.projectId&&replacement.areaId===item.areaId)){unknowns.push(`Work operation ${proposed.kind} has no exact retained replacement scope.`);continue;}
  const operationId='operation:'+await contentHash(canonical([owner,target,chunk.extractionDigest,proposed]));approvedOperationIds.add(operationId);operations.push({...proposed,operationId,inputDigest:chunk.inputDigest});
 }
 const workItems=await reconcileWorkItems({ownerId:owner,sourceWatermark:input.historyInputWatermark,now:currentTime(),items,events:[],claims,operations,scopeMatches:(item,cited,operation)=>cited.every(c=>c.claim.projectId===item.projectId&&c.claim.areaId===item.areaId&&(item.claimIds.includes(c.claim.id)||approvedOperationIds.has(operation.operationId)))});
 const current=await readCurrent(db,owner,currentTime()),story=target.areaId===null?undefined:await buildAreaStory({ownerId:owner,projectId:target.projectId,areaId:target.areaId,planningRevision:input.planningRevision,sourceWatermark:input.historyInputWatermark,associationVersion:'native-rules-v1',extractorVersion:chunk.extractorVersion,generatedAt:currentTime(),workspace:current.workspace,items:workItems.items,claims,unknowns,contradictions:[],trustAcceptance:async()=>false});
 const expectedRows=[...input.expectedRows];for(const operation of operations)if(!expectedRows.some(row=>row.kind==='work_item'&&row.logicalId===operation.workItemId))expectedRows.push({kind:'work_item',logicalId:operation.workItemId,rowRevision:null,contentHash:null});
 const journal=await prepareHistoryAnalysisCompletion(db,owner,{requestId,inputDigest:chunk.inputDigest,claimHashes:await Promise.all(proposal.claims.map(c=>contentHash(canonical(c.claim)))),checkpointDigest:await contentHash(canonical(proposal.checkpoint)),usage:proposal.usage,now:currentTime()},{validatedClaims:proposal.claims});
 signal.throwIfAborted();
 const jobProgress=await prepareAreaAnalysisProgress(db,active,{authority,now:currentTime(),inputDigest:chunk.inputDigest,outcome:'continue',cursor,reservedRequestIds:active.control!.reservedRequestIds,retryAt:currentTime()});
 if(!jobProgress)return result('conflict',['Analysis lease changed before atomic publication.'],proposal.checkpoint,requestId,cursor);
 signal.throwIfAborted();
 const publicationAt=currentTime();if(!await currentAuthority())return result('conflict',['Analysis authority expired before publication.'],proposal.checkpoint,requestId,cursor);
 const publicationWorkItems={...workItems,events:workItems.events.map(event=>({...event,recordedAt:publicationAt}))};
 const published=await publishHistoryProjection(db,owner,{planningRevision:input.planningRevision,historyHead:input.historyHead,historyInputWatermark:input.historyInputWatermark,target,analysisInput:{inputDigest:chunk.inputDigest,normalizationVersion:chunk.normalizationVersion,extractorVersion:chunk.extractorVersion,associationVersion:'native-rules-v1',messageRevisionIds:chunk.messageRevisionIds,segmentIds:chunk.segmentIds,repositorySnapshotIds:chunk.snapshot.repositories.map(r=>r.snapshot.id)},checkpoint:proposal.checkpoint,validatedClaims:proposal.claims,supportingClaims:supporting,workItems:publicationWorkItems,...(story?{story}:{}),expectedRows},{now:publicationAt,journal,jobProgress,beforeCommit:async()=>{signal.throwIfAborted();if(!await currentAuthority())throw Error('Analysis authority expired before atomic commit');}});
 if(published.status!=='committed'&&published.status!=='replayed')return result('conflict',['Projection publication input changed.'],proposal.checkpoint,requestId,cursor);
 return result('published',unknowns,proposal.checkpoint,requestId,cursor,proposal.operations);
 } catch {
  await finish('failed',active.control!.cursor,signal.aborted?'timeout':'processing').catch(()=>null);
  return result('unavailable',[...input.unknowns,'Analysis attempt could not publish; any reserved provider outcome remains journaled and must not be retried blindly.'],null,requestId,active.control!.cursor);
 }
}
