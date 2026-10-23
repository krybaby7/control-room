import type {AreaStory,StoryCheckpoint,HistoryWorkItem} from './contracts.ts';
import type {Workspace} from '../types.ts';
import {AreaStorySchema,StoryCheckpointSchema} from './validation.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {requireValidatedClaim,type ValidatedHistoryClaim} from './claims.ts';
export interface StoryInput{
 ownerId:string;projectId:string;areaId:string;planningRevision:number;sourceWatermark:string;associationVersion:string;extractorVersion:string;generatedAt:string;
 workspace:Workspace;items:readonly HistoryWorkItem[];claims:readonly ValidatedHistoryClaim[];unknowns:readonly string[];contradictions:readonly string[];
 acceptedEntries?:readonly {text:string;claimIds:string[];acceptanceRef:string}[];
 trustAcceptance:(ref:string,projectId:string,areaId:string)=>Promise<boolean>;
 next?:readonly {text:string;claimIds:string[];taskId:string|null}[];
}
export async function buildAreaStory(input:StoryInput):Promise<{story:AreaStory;checkpoint:StoryCheckpoint;requiresAtomicPublication:true}>{
 if(!input.workspace.areas?.some(a=>a.id===input.areaId&&a.projectId===input.projectId))throw Error('Stable area required for a story.');
 const claims=new Map(input.claims.map(claim=>{requireValidatedClaim(claim,input.ownerId,input.sourceWatermark);return [claim.claim.id,claim] as const;}));
 const resolve=(ids:readonly string[])=>ids.map(id=>{const claim=claims.get(id);if(!claim||claim.claim.projectId!==input.projectId||claim.claim.areaId!==input.areaId)throw Error('Story claim is missing, foreign or unvalidated.');return claim;});
 const items=input.items.filter(item=>item.projectId===input.projectId&&item.areaId===input.areaId),finished:AreaStory['finished']=[],open:AreaStory['open']=[],next:AreaStory['next']=[];
 const finishedClaims=new Set<string>();
 for(const item of items){
  const evidence=resolve(item.claimIds);
  if(item.state==='observed_finished')for(const c of evidence.filter(c=>c.completionSupported&&['implementation','verification','release'].includes(c.claim.kind))){if(!finishedClaims.has(c.claim.id)){finished.push({text:c.claim.text,citations:c.claim.citations,claimIds:[c.claim.id],basis:c.claim.basis,acceptanceRef:null});finishedClaims.add(c.claim.id);}}
  else if(item.state==='open')open.push({workItemId:item.id,text:item.title,citations:evidence.flatMap(c=>c.claim.citations)});
 }
 for(const entry of input.acceptedEntries??[]){
  resolve(entry.claimIds);
  if(!await input.trustAcceptance(entry.acceptanceRef,input.projectId,input.areaId))throw Error('Story acceptance has no owner provenance.');
  finished.push({text:entry.text,citations:[],claimIds:[...entry.claimIds],basis:'accepted',acceptanceRef:entry.acceptanceRef});
 }
 for(const entry of input.next??[]){const evidence=resolve(entry.claimIds);if(!evidence.length)throw Error('Next action requires retained support.');if(entry.taskId!==null&&!input.workspace.tasks.some(t=>t.id===entry.taskId&&t.projectId===input.projectId&&t.areaId===input.areaId))throw Error('Next action task is foreign.');next.push({text:entry.text,citations:evidence.flatMap(c=>c.claim.citations),taskId:entry.taskId});}
 const areaClaims=[...claims.values()].filter(c=>c.claim.projectId===input.projectId&&c.claim.areaId===input.areaId),unknowns=[...new Set([...input.unknowns,...areaClaims.flatMap(c=>c.unknowns)])];
 const inputDigest=await contentHash(canonical({projectId:input.projectId,areaId:input.areaId,planningRevision:input.planningRevision,sourceWatermark:input.sourceWatermark,associationVersion:input.associationVersion,extractorVersion:input.extractorVersion,items,claims:areaClaims.map(c=>c.claim),finished,open,next,unknowns,contradictions:input.contradictions}));
 const story=AreaStorySchema.parse({id:'story:'+await contentHash(canonical([inputDigest,input.generatedAt])),projectId:input.projectId,areaId:input.areaId,planningRevision:input.planningRevision,sourceWatermark:input.sourceWatermark,generatedAt:input.generatedAt,finished,open,next,unknowns,contradictions:[...input.contradictions]});
 const checkpoint=StoryCheckpointSchema.parse({storyId:story.id,planningRevision:input.planningRevision,sourceWatermark:input.sourceWatermark,associationVersion:input.associationVersion,extractorVersion:input.extractorVersion,inputDigest});
 return {story,checkpoint,requiresAtomicPublication:true};
}
