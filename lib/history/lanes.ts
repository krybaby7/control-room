import type {Workspace} from '../types.ts';
import type {AreaLaneSummary,AreaProgress,AreaStory,RoadmapScope,SourceCapability,CoverageSnapshot,HistoryGap,HistorySourceKind,HistoryWorkItem} from './contracts.ts';
export function progressLabel(lane:AreaLaneSummary):string {
 if(!lane.agreedScope||lane.checkpoints.length===0)return 'Scope not set';
 return `${lane.checkpoints.filter(row=>row.accepted).length} of ${lane.checkpoints.length} checkpoints accepted`;
}
export interface LaneProjectionInput {workspace:Workspace;progress:AreaProgress[];stories:AreaStory[];scopes:RoadmapScope[];planningRevision:number;sourceWatermark:string;workItems?:HistoryWorkItem[];ownerRequests?:Array<{id:string;projectId:string;areaId:string|null;resolved:boolean}>;freshness?:AreaLaneSummary['freshness'];}
/** Stable planning order; history arrival time never decides placement. */
export function projectLanes(input:LaneProjectionInput):AreaLaneSummary[]{
 const {workspace}=input;const result:AreaLaneSummary[]=[];
 for(const project of workspace.projects.filter(row=>!row.archivedAt)){
  const areas=(workspace.areas??[]).filter(row=>row.projectId===project.id).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  const ids:Array<string|null>=areas.filter(area=>!area.archivedAt||workspace.tasks.some(task=>task.areaId===area.id)||input.progress.some(row=>row.areaId===area.id)||input.stories.some(row=>row.areaId===area.id)||input.scopes.some(row=>row.areaId===area.id)).map(row=>row.id);
  if(workspace.tasks.some(row=>row.projectId===project.id&&!row.areaId)||input.ownerRequests?.some(row=>row.projectId===project.id&&row.areaId===null)||input.workItems?.some(row=>row.projectId===project.id&&row.areaId===null))ids.push(null);
  for(const areaId of ids){
   const area=areas.find(row=>row.id===areaId),progress=input.progress.find(row=>row.projectId===project.id&&row.areaId===areaId),story=input.stories.find(row=>row.projectId===project.id&&row.areaId===areaId);
   const scope=input.scopes.find(row=>row.projectId===project.id&&row.areaId===areaId&&row.id===progress?.roadmap?.scopeId&&row.revision===progress.roadmap.scopeRevision);
   const stale=[progress,story].some(row=>row&&(row.planningRevision!==input.planningRevision||row.sourceWatermark!==input.sourceWatermark));
   const requests=input.ownerRequests?.filter(row=>row.projectId===project.id&&row.areaId===areaId&&!row.resolved)??[];
   result.push({projectId:project.id,areaId,title:area?`${area.name}${area.archivedAt?' (archived)':''}`:'Unclassified',agreedScope:!!scope?.agreedAt&&!!progress?.roadmap?.agreed,checkpoints:(scope?.checkpoints??[]).map(checkpoint=>{const observed=progress?.roadmap?.checkpoints.find(row=>row.id===checkpoint.id);return {id:checkpoint.id,label:checkpoint.label,observed:observed?.observedStage??'unknown',accepted:observed?.ownerAccepted??false};}),needsOwnerCount:new Set(requests.map(row=>row.id)).size,nextAction:story?.next[0]?.text??null,storyId:story?.id??null,freshness:input.freshness==='error'?'error':stale?'stale':input.freshness&&input.freshness!=='current'?input.freshness:!progress?'unverified':!progress.coverageComplete||progress.unknowns.length>0||!!story?.contradictions.length||!!story?.unknowns.length?'partial':'current'});
  }
 }
 return result;
}
export const SOURCE_LABELS:Record<HistorySourceKind,string>={codex_local:'Codex local',codex_cloud:'Codex cloud',claude_code_local:'Claude Code local',claude_code_cloud:'Claude Code cloud'};
export interface HistorySourceStatus {capability:SourceCapability;coverage?:CoverageSnapshot;gaps?:HistoryGap[];paused?:boolean;connected?:boolean;manual?:boolean;analysisAt?:string|null;analysisWatermark?:string|null;}
export function sourceStatus(source:HistorySourceStatus):string {
 const {capability:c,coverage:s}=source;
 if(source.connected===false)return 'Not connected';
 if(c.inventory==='unsupported'||c.contentRead==='unsupported')return 'Unsupported';
 if(source.paused)return 'Paused';
 if(s?.status==='error')return 'Error';
 if(s?.status==='stale')return 'Stale';
 if(s?.status==='syncing')return 'Syncing';
 if(c.inventory==='unverified'||c.contentRead==='unverified'||!c.unattendedRead||!c.verifiedAt||!s)return 'Awaiting verification';
 if(s.status==='partial'||!s.inventoryComplete||!s.contentComplete||s.partial>0||s.unavailable>0||s.unresolvedGaps>0||source.gaps?.some(gap=>!gap.resolvedAt)||c.inventory==='partial'||c.contentRead==='partial')return 'Partial';
 if(s.status!=='current'||!s.lastInventorySuccessAt||!s.lastContentSuccessAt)return 'Awaiting verification';
 return 'Current';
}
export function historySummary(sources:HistorySourceStatus[]):string {
 const missing=Object.keys(SOURCE_LABELS).filter(kind=>!sources.some(source=>source.capability.kind===kind)).length;
 const attention=sources.filter(source=>sourceStatus(source)!=='Current').length+missing;
 return attention?`${attention} source${attention===1?'':'s'} need${attention===1?'s':''} attention`:'Selected source coverage current';
}
