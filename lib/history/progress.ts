import type {AreaProgress,CheckpointAcceptance,HistoryWorkItem,RoadmapScope} from './contracts.ts';
import type {Workspace} from '../types.ts';
import {AreaProgressSchema,RoadmapScopeSchema,CheckpointAcceptanceSchema} from './validation.ts';
import {requireValidatedClaim,type ValidatedHistoryClaim} from './claims.ts';
export interface ProgressInput{
 ownerId:string;projectId:string;areaId:string;planningRevision:number;sourceWatermark:string;workspace:Workspace;
 items:readonly HistoryWorkItem[];claims:readonly ValidatedHistoryClaim[];scope:RoadmapScope|null;
 assessments:readonly CheckpointAcceptance[];coverageComplete:boolean;unknowns:readonly string[];
 /** Both callbacks must resolve native owner grants, not imported payload booleans. */
 trustAgreement:(scope:RoadmapScope)=>Promise<boolean>;
 trustAssessment:(assessment:CheckpointAcceptance)=>Promise<boolean>;
 trustTaskCompletion:(taskId:string)=>Promise<boolean>;
 /** Checkpoint-specific support, not a maximum stage across unrelated tasks. */
 checkpointEvidence:(checkpointId:string)=>{stage:NonNullable<AreaProgress['roadmap']>['checkpoints'][number]['observedStage'];claimIds:string[]};
}
export async function buildAreaProgress(input:ProgressInput):Promise<AreaProgress>{
 if(!input.ownerId||!input.workspace.areas?.some(a=>a.id===input.areaId&&a.projectId===input.projectId))throw Error('Stable owner project area required.');
 const claims=new Map(input.claims.map(claim=>{requireValidatedClaim(claim,input.ownerId,input.sourceWatermark);return [claim.claim.id,claim] as const;}));
 const inArea=(item:HistoryWorkItem)=>item.projectId===input.projectId&&item.areaId===input.areaId;
 const items=input.items.filter(inArea),unknowns=[...input.unknowns];
 let roadmap:AreaProgress['roadmap']=null;
 if(input.scope){
  const scope=RoadmapScopeSchema.parse(input.scope);
  if(scope.projectId!==input.projectId||scope.areaId!==input.areaId)throw Error('Roadmap scope is foreign.');
  if(new Set(scope.checkpoints.map(c=>c.id)).size!==scope.checkpoints.length)throw Error('Duplicate roadmap checkpoint.');
  if(scope.checkpoints.length&&scope.agreedAt!==null&&await input.trustAgreement(scope)){
   const assessments=input.assessments.map(a=>CheckpointAcceptanceSchema.parse(a)).filter(a=>a.scopeId===scope.id&&a.scopeRevision===scope.revision);
   const checkpoints:NonNullable<AreaProgress['roadmap']>['checkpoints']=[];
   for(const checkpoint of scope.checkpoints){
    const evidence=input.checkpointEvidence(checkpoint.id);
    const validated=evidence.claimIds.map(id=>{const claim=claims.get(id);if(!claim||claim.claim.projectId!==input.projectId||claim.claim.areaId!==input.areaId)throw Error('Checkpoint claim is foreign or unverified.');return claim;});
    if(evidence.stage!=='unknown'&&!validated.length)throw Error('Checkpoint stage requires exact supporting claims.');
    if(evidence.stage==='implemented'&&!validated.some(c=>c.completionSupported&&c.claim.basis==='observed'&&['implementation','verification','release'].includes(c.claim.kind)))throw Error('Checkpoint stage exceeds observed evidence.');
    if(evidence.stage==='verified'&&!validated.some(c=>c.claim.kind==='verification'&&c.claim.basis==='observed')||evidence.stage==='released'&&!validated.some(c=>c.claim.kind==='release'&&c.claim.basis==='observed'))throw Error('Checkpoint stage exceeds observed evidence.');
    const candidates=[];for(const a of assessments.filter(a=>a.checkpointId===checkpoint.id))if(await input.trustAssessment(a))candidates.push(a);
    // Native assessment IDs encode planning order; clocks may tie. Require unique identity.
    if(new Set(candidates.map(a=>a.id)).size!==candidates.length)throw Error('Duplicate checkpoint assessment.');
    const assessment=candidates.sort((a,b)=>a.id.localeCompare(b.id)).at(-1),accepted=assessment?.verdict==='accepted';
    checkpoints.push({id:checkpoint.id,mandatory:checkpoint.mandatory,observedStage:evidence.stage,claimIds:[...evidence.claimIds],ownerAccepted:accepted,acceptanceRef:accepted?assessment!.id:null});
   }
   roadmap={scopeId:scope.id,scopeRevision:scope.revision,agreed:true,defined:checkpoints.length,ownerAccepted:checkpoints.filter(c=>c.ownerAccepted).length,checkpoints};
  }else unknowns.push('Scope not set: the current roadmap has no owner-agreed denominator.');
 }else unknowns.push('Scope not set.');
 const acceptedTaskIds:string[]=[];
 for(const task of input.workspace.tasks.filter(t=>t.projectId===input.projectId&&t.areaId===input.areaId&&t.status==='done'))if(await input.trustTaskCompletion(task.id))acceptedTaskIds.push(task.id);
 const observedFinishedWorkItemIds=items.filter(item=>item.state==='observed_finished'&&item.claimIds.some(id=>{const claim=claims.get(id);return claim?.completionSupported&&claim.claim.projectId===item.projectId&&claim.claim.areaId===item.areaId;})).map(i=>i.id);
 return AreaProgressSchema.parse({projectId:input.projectId,areaId:input.areaId,planningRevision:input.planningRevision,sourceWatermark:input.sourceWatermark,observedFinishedWorkItemIds,acceptedTaskIds,openWorkItemIds:items.filter(i=>i.state==='open'&&i.disposition==='requested').map(i=>i.id),roadmap,coverageComplete:input.coverageComplete,unknowns:[...new Set(unknowns)]});
}
