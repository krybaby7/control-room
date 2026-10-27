import type {Activity,Milestone,MilestoneStatus,Project,Task,Workspace} from '../types.ts';
import type {JobReadModel} from '../agents/read-model.ts';
import type {AgentJobEventV1,AgentJobStatus,AgentProvider} from '../agents/contracts.ts';
import type {DeviceConnectivity,RuntimeMetrics} from '../runtime/contracts.ts';
import type {ChatContextMetadata,LocalAnalysisReport} from '../../shared/local-analysis.mjs';
import type {GithubAnalysisReport} from '../../shared/github-analysis.mjs';
import type {PersonalConnectorJob,PersonalConnectorView} from './contracts.ts';
import {validateProjectBriefing,type BriefingAreaState,type BriefingBend,type BriefingIntentionSource,type BriefingIntentionState,type BriefingStatusLevel,type ProjectBriefing} from '../../shared/project-briefing.mjs';
import type {SavedProjectBriefing} from '../project-briefing-client.ts';
import {getBlockers,getRecommendations} from '../planning.ts';
import {cairoDate,isCurrentWeek} from '../calendar.ts';
import {archivedEntity} from '../entity-links.ts';
import {excerpt,percent,secondsBetween} from './format.ts';
import {personalCompanionStatus,personalJobFailureReason} from '../project-action-reasons.ts';

/** Pure derivation of the mission-control view model. Every value is computed from saved
 * records plus the supplied clock; nothing here infers execution, acceptance or spending. */
export type JobRow=JobReadModel['jobs'][number];
export interface JobDetailLike {provider:AgentProvider|null;events:AgentJobEventV1[]}
export interface RuntimeDeviceLike {device:{id:string;label:string;archivedAt:string|null};enrolled:boolean;revoked:boolean;connectivity:DeviceConnectivity;lastLiveReceivedAt:string|null;sources:{source:string;instanceId:string;freshness:{source:string;heartbeatAgeSeconds:number|null;effectiveSampleAgeUpperBoundSeconds:number|null};observation:{state:string;diagnostic:string;metrics:RuntimeMetrics|null}|null}[]}
export interface SavedReportLike<R> {evidenceId:string;version:number;projectId:string;report:R;recordedAt:string}
export type FeedKey='jobs'|'runtime'|'connector'|'local'|'cloud'|'briefings';
export interface FeedState {status:'loading'|'ok'|'failed'|'unconfigured';checkedAt:string|null;message?:string}
export type FeedStates=Record<FeedKey,FeedState>;
export interface DashboardInputs {
 now:string;workspace:Workspace;jobs:JobReadModel|null;jobDetails:Record<string,JobDetailLike>;runtime:{devices:RuntimeDeviceLike[]}|null;
 connector:PersonalConnectorView|null;localReports:SavedReportLike<LocalAnalysisReport>[];cloudReports:SavedReportLike<GithubAnalysisReport>[];briefings:SavedProjectBriefing[];feeds:FeedStates;
}
export type SignalTone='good'|'warn'|'bad'|'idle'|'live';
export interface PcStatus {state:'online'|'stale'|'offline'|'never-seen'|'revoked'|'not-enrolled'|'unknown';label:string;detail:string;tone:SignalTone;deviceLabel:string|null;heartbeatAgeSeconds:number|null;metrics:{cpu:number|null;memory:number|null;gpu:number|null;gpuTemperatureC:number|null}|null;metricsAgeSeconds:number|null;metricsFreshness:string|null}
export interface ConnectorStatus {state:'online'|'away'|'disconnected'|'unconfigured'|'unknown';label:string;detail:string;tone:SignalTone;lastSeenAt:string|null;providers:{id:'codex'|'claude';label:string;ready:boolean;detail:string}[]}
export interface ExecutionStatus {enabled:boolean;diagnostic:string;label:string;tone:SignalTone}
export interface CloudStatus {execution:ExecutionStatus;lastReportAt:string|null;reportCount:number}
export interface ActiveJob {id:string;projectId:string;projectName:string;projectColor:Project['color'];taskId:string;taskTitle:string;operation:string;operationLabel:string;status:AgentJobStatus;statusLabel:string;tone:SignalTone;provider:AgentProvider;providerLabel:string;model:string;observedModel:string|null;deviceId:string|null;deviceLabel:string|null;location:'pc';stage:string|null;stageLabel:string;completedUnits:number|null;totalUnits:number|null;percent:number|null;startedAt:string|null;elapsedSeconds:number|null;timeoutSeconds:number;deadlineAt:string|null;timePercent:number|null;lastEventAt:string|null;eventCount:number;diagnostic:string;operationalRevision:number}
export interface RecentJob {id:string;projectId:string;projectName:string;projectColor:Project['color'];taskTitle:string;operation:string;operationLabel:string;status:AgentJobStatus;statusLabel:string;tone:SignalTone;provider:AgentProvider;providerLabel:string;model:string;observedModel:string|null;modelVerified:boolean|null;finishedAt:string|null;runtimeSeconds:number|null;tokens:{input:number|null;output:number|null}|null;accepted:boolean;artifacts:number;diagnostic:string}
export interface PersonalJob {id:string;kind:string;status:PersonalConnectorJob['status'];projectId:string|null;projectName:string|null;repositoryName:string|null;provider:'codex'|'claude'|null;providerLabel:string|null;createdAt:string;claimedAt:string|null;active:boolean;tone:SignalTone;label:string}
export interface ChatSource {provider:'codex'|'claude';label:string;status:ChatContextMetadata['sources'][number]['status'];statusLabel:string;latestAt:string|null;messages:number;characters:number;truncated:boolean}
export interface ProjectAnalysis {kind:'local'|'cloud';kindLabel:string;provider:'codex'|'claude';providerLabel:string;model:string;observedModel:string|null;recordedAt:string;completedAt:string;repositoryName:string;head:string;dirty:boolean|null;summary:string;excerpt:string;suggestedTasks:number;findings:number;chats:ChatSource[]|null;chatCharacters:number|null}
export interface ProjectProgress {milestonesDone:number;milestonesTotal:number;milestonePercent:number;tasksDone:number;tasksOpen:number;tasksTotal:number;taskPercent:number;inProgress:number;inReview:number;proposed:number;blocked:number;weeklyPinned:number;overdue:number}
export type ProjectAgentState='running'|'cancelling'|'queued'|'reconcile'|'awaiting_approval'|'idle';
/** One of the owner's intentions as the card shows it: labelled, toned, tied to an area and marked when it is newer than the previous briefing. */
export interface BriefingIntentionRow {date:string|null;title:string;outcome:string;state:BriefingIntentionState;stateLabel:string;tone:SignalTone;sourceLabel:string;areaId:string|null;areaName:string|null;bend:BriefingBend|null;evidence:ProjectBriefing['intentions'][number]['evidence'];isNew:boolean}
export interface BriefingAreaRow {id:string;name:string;state:BriefingAreaState;stateLabel:string;tone:SignalTone;done:number;total:number;note:string;isAim:boolean;repositoryName?:string|null}
/** The ledger and the map, ready to draw. `newSince` is the previous briefing's horizon when one was carried forward. */
export interface BriefingLedger {intentions:BriefingIntentionRow[];areas:BriefingAreaRow[];links:{from:string;to:string}[];aimArea:string|null;newSince:string|null;bends:number}
/** The owner-facing briefing for one project: the freshest of the saved copy and a completed-but-unsaved
 * briefing from the PC, plus what the dashboard needs to request or keep one current. */
export interface BriefingView {
 state:'ready'|'running'|'queued'|'none';
 report:ProjectBriefing|null;source:'saved'|'completed'|null;recordedAt:string|null;version:number|null;evidenceId:string|null;
 unsaved:{requestId:string;briefingSha256:string}|null;
 status:{level:BriefingStatusLevel|null;label:string;tone:SignalTone};ledger:BriefingLedger;
 freshness:{newWork:boolean;detail:string|null;basedOnAt:string|null};evidenceLine:string;
 repositories:{key:string;name:string}[];changedFolderNames:string[];evidenceCoverage:{key:string;name:string;line:string}[];
 providerLabel:string|null;originLabel:string|null;
 repositoryKey:string|null;repositoryName:string|null;repositoryChoices:{key:string;name:string}[];
 policy:{repositoryKey:string;provider:'codex'|'claude';enabled:boolean;minIntervalMinutes:number;lastBriefAt:string|null}|null;
 providers:{id:'codex'|'claude';label:string;ready:boolean}[];connector:ConnectorStatus['state'];canRequest:boolean;requestHint:string|null;
 activeJob:{id:string;status:'queued'|'claimed';providerLabel:string;origin:'owner'|'auto';createdAt:string;claimedAt:string|null}|null;
 lastFailure:{at:string;providerLabel:string;reason:string;standalone?:boolean}|null;
}
export interface ProjectTile {project:Project;progress:ProjectProgress;level:number;milestone:{id:string;title:string;status:MilestoneStatus;targetDate:string|null}|null;agent:{state:ProjectAgentState;label:string;tone:SignalTone;jobs:ActiveJob[];personal:PersonalJob[]};analysis:ProjectAnalysis|null;briefing:BriefingView;activity:LogEntry[];nextAction:{task:Task;reason:string}|null;tokens:{input:number;output:number;runs:number;reported:number};lastRunAt:string|null;lastActivityAt:string|null}
export interface LogEntry {id:string;text:string;at:string;projectId:string|null;projectName:string|null;projectColor:Project['color']|null}
export interface AttentionItem {key:string;kind:'review'|'approval'|'reconcile'|'inbox'|'overdue'|'carry'|'decision';title:string;detail:string;projectId:string|null;projectName:string|null;taskId?:string;jobId?:string;tone:SignalTone}
export interface DashboardModel {
 now:string;today:string;
 hud:{pc:PcStatus;connector:ConnectorStatus;cloud:CloudStatus;agents:{running:number;queued:number;awaitingApproval:number;cancelling:number;reconcile:number;personalActive:number;label:string;tone:SignalTone};attention:{total:number;label:string;tone:SignalTone}};
 projects:ProjectTile[];operations:{active:ActiveJob[];recent:RecentJob[];personal:PersonalJob[];execution:ExecutionStatus};attention:AttentionItem[];log:LogEntry[];feeds:FeedStates;
}

export const ACTIVE_JOB_STATUSES:readonly AgentJobStatus[]=['queued','leased','running','cancelling'];
const TERMINAL_JOB_STATUSES:readonly AgentJobStatus[]=['succeeded','failed','cancelled','blocked','rejected'];
const STATUS_LABELS:Record<AgentJobStatus,{label:string;tone:SignalTone}>={awaiting_approval:{label:'Awaiting your approval',tone:'warn'},queued:{label:'Queued for the PC',tone:'live'},leased:{label:'Claimed by the PC',tone:'live'},running:{label:'Running',tone:'live'},cancelling:{label:'Cancelling',tone:'warn'},succeeded:{label:'Succeeded',tone:'good'},failed:{label:'Failed',tone:'bad'},cancelled:{label:'Cancelled',tone:'idle'},blocked:{label:'Blocked',tone:'bad'},reconcile_required:{label:'Needs reconciliation',tone:'warn'},rejected:{label:'Rejected',tone:'idle'}};
const STAGE_LABELS:Record<string,string>={preparing:'Preparing the workspace',executing:'Executing with the model',validating:'Validating the output',uploading:'Uploading artifacts'};
const OPERATION_LABELS:Record<string,string>={'project.inspect':'Inspect project','project.propose-patch':'Propose patch'};
const PROVIDER_LABELS:Record<AgentProvider,string>={codex:'Codex',claude:'Claude Code'};
const PROVIDER_DETAIL:Record<string,string>={ready:'Ready',not_installed:'Not installed',auth_required:'Sign-in needed',unavailable:'Unavailable'};
const CHAT_STATUS:Record<ChatSource['status'],string>={included:'Included','not-found':'No matching chat',unavailable:'History unavailable',filtered:'Filtered out',deferred:'Deferred'};
const EXECUTION_LABELS:Record<string,{label:string;tone:SignalTone}>={ready:{label:'Execution window open',tone:'good'},not_configured:{label:'Execution not configured',tone:'idle'},private_ingress_unavailable:{label:'Private access window closed',tone:'idle'},not_installed:{label:'Executor not installed',tone:'idle'}};
const ACTIVE_ORDER:Record<string,number>={running:0,leased:1,cancelling:2,queued:3};
const TONE_RANK:Record<SignalTone,number>={bad:0,warn:1,live:2,good:3,idle:4};
const BRIEFING_STATUS:Record<BriefingStatusLevel,{label:string;tone:SignalTone}>={'on-track':{label:'On track',tone:'good'},'at-risk':{label:'At risk',tone:'warn'},blocked:{label:'Blocked',tone:'bad'},paused:{label:'Paused',tone:'idle'},unclear:{label:'Unclear',tone:'idle'}};
export const INTENTION_STATE:Record<BriefingIntentionState,{label:string;tone:SignalTone}>={reached:{label:'Reached',tone:'good'},negative:{label:'Reached, result negative',tone:'warn'},changed:{label:'Changed by you',tone:'warn'},paused:{label:'Started, then paused',tone:'warn'},'not-reached':{label:'Not reached',tone:'bad'},'in-progress':{label:'In progress',tone:'live'},open:{label:'Open',tone:'live'}};
export const INTENTION_SOURCE:Record<BriefingIntentionSource,string>={'local-codex':'a Codex chat on your PC','local-claude':'a Claude Code chat on your PC',cloud:'cloud work on GitHub',plan:'your plan',repository:'the repository',unknown:'an unknown source'};
export const AREA_STATE:Record<BriefingAreaState,{label:string;tone:SignalTone}>={proven:{label:'Proven on real data',tone:'good'},built:{label:'Built, tested on made-up data',tone:'live'},partial:{label:'Partly proven',tone:'live'},open:{label:'Open: no result yet',tone:'warn'},paused:{label:'Paused by you',tone:'warn'},blocked:{label:'Blocked',tone:'bad'},none:{label:'Not built, on purpose',tone:'idle'}};
const BRIEF_FAILURES:Record<string,string>={provider_unavailable:'the assistant was not signed in on your PC',deadline_exceeded:'it took longer than allowed',cancelled:'it was cancelled',analysis_failed:'the assistant did not return a usable briefing',interrupted:'your PC app was restarted',disconnected:'your PC was disconnected'};

export function providerForModel(model:string):AgentProvider{return /^claude/iu.test(model)?'claude':'codex';}
export function operationLabel(operation:string):string{return OPERATION_LABELS[operation]??operation;}
export function jobStatusLabel(status:AgentJobStatus):{label:string;tone:SignalTone}{return STATUS_LABELS[status];}

function openTask(task:Task):boolean{return !['done','archived'].includes(task.status);}
function latestEvent<K extends AgentJobEventV1['kind']>(events:AgentJobEventV1[],kind:K):Extract<AgentJobEventV1,{kind:K}>|null{
 let found:Extract<AgentJobEventV1,{kind:K}>|null=null;
 for(const event of events)if(event.kind===kind&&(found===null||event.sequence>found.sequence))found=event as Extract<AgentJobEventV1,{kind:K}>;
 return found;
}
function projectOf(workspace:Workspace,id:string|null|undefined):Project|null{return id?workspace.projects.find(project=>project.id===id)??null:null;}
function pcStatus(runtime:DashboardInputs['runtime'],feed:FeedState,now:string):PcStatus{
 const devices=(runtime?.devices??[]).filter(row=>!row.device.archivedAt);
 const rank:Record<DeviceConnectivity,number>={online:0,stale:1,offline:2,'never-seen':3,revoked:4};
 const best=[...devices].sort((a,b)=>rank[a.connectivity]-rank[b.connectivity]||(Date.parse(b.lastLiveReceivedAt??'')||0)-(Date.parse(a.lastLiveReceivedAt??'')||0))[0];
 if(!best){const unknown=!runtime&&feed.status!=='ok';return {state:unknown?'unknown':'not-enrolled',label:unknown?'PC status unknown':'No PC enrolled',detail:unknown?(feed.status==='loading'?'Reading runtime records…':'Runtime records could not be read.'):'Enroll your PC under Runtime to see whether it is on.',tone:'idle',deviceLabel:null,heartbeatAgeSeconds:null,metrics:null,metricsAgeSeconds:null,metricsFreshness:null};}
 const age=best.lastLiveReceivedAt?secondsBetween(best.lastLiveReceivedAt,now):null;
 const states:Record<DeviceConnectivity,{state:PcStatus['state'];label:string;tone:SignalTone;detail:string}>={
  online:{state:'online',label:'PC online',tone:'good',detail:age===null?'Live heartbeat received.':`Heartbeat ${Math.round(age)}s ago.`},
  stale:{state:'stale',label:'PC heartbeat stale',tone:'warn',detail:age===null?'The last heartbeat is older than expected.':`Last heartbeat ${Math.round(age/60)} min ago.`},
  offline:{state:'offline',label:'PC offline',tone:'bad',detail:best.lastLiveReceivedAt?'No heartbeat in more than five minutes.':'No heartbeat received.'},
  'never-seen':{state:'never-seen',label:'PC never seen',tone:'idle',detail:'Enrolled, but the bridge has not reported yet.'},
  revoked:{state:'revoked',label:'PC credential revoked',tone:'idle',detail:'Re-enroll the device under Runtime to resume telemetry.'},
 };
 const base=states[best.connectivity];
 const source=best.sources.find(row=>row.observation?.metrics&&row.source==='pc-command-center')??best.sources.find(row=>row.observation?.metrics)??null;
 const metrics=source?.observation?.metrics?{cpu:source.observation.metrics.cpuPercent,memory:source.observation.metrics.memoryPercent,gpu:source.observation.metrics.gpuUtilizationPercent,gpuTemperatureC:source.observation.metrics.gpuTemperatureC}:null;
 return {...base,deviceLabel:best.device.label,heartbeatAgeSeconds:age,metrics,metricsAgeSeconds:source?.freshness.effectiveSampleAgeUpperBoundSeconds??source?.freshness.heartbeatAgeSeconds??null,metricsFreshness:source?.freshness.source??null};
}
function connectorStatus(connector:PersonalConnectorView|null,feed:FeedState,now:string):ConnectorStatus{
 const providers=(view:PersonalConnectorView|null)=>(['codex','claude'] as const).map(id=>({id,label:PROVIDER_LABELS[id],ready:view?.providers[id].ready??false,detail:view?PROVIDER_DETAIL[view.providers[id].detail]??view.providers[id].detail:'Unknown'}));
 if(!connector){
  if(feed.status==='unconfigured')return {state:'unconfigured',label:'Personal PC app not configured',detail:'Connect this PC under Repositories to see Codex and Claude readiness.',tone:'idle',lastSeenAt:null,providers:providers(null)};
  return {state:'unknown',label:'Personal PC app status unknown',detail:feed.status==='loading'?'Checking the personal PC connection…':'The personal PC connection could not be read.',tone:'idle',lastSeenAt:null,providers:providers(null)};
 }
 const app=personalCompanionStatus(connector.companion),appLabel=app.label+(connector.companion?.release?` (${connector.companion.release})`:'');
 if(!connector.connected)return {state:'disconnected',label:'Personal PC app disconnected',detail:`${appLabel}. Reconnect it under Repositories to analyze local folders.`,tone:'idle',lastSeenAt:connector.lastSeenAt,providers:providers(connector)};
 if(connector.online)return {state:'online',label:'Personal PC app online',detail:`${appLabel}. Polling for your requests right now.`,tone:app.state==='outdated'?'warn':'good',lastSeenAt:connector.lastSeenAt,providers:providers(connector)};
 const age=connector.lastSeenAt?secondsBetween(connector.lastSeenAt,now):null;
 return {state:'away',label:'Personal PC app away',detail:`${appLabel}. `+(age===null?'Connected, but it has not checked in yet.':`Last check-in ${age<120?`${Math.round(age)}s`:`${Math.round(age/60)} min`} ago. Start Control Room on the PC to resume.`),tone:'warn',lastSeenAt:connector.lastSeenAt,providers:providers(connector)};
}
function executionStatus(jobs:JobReadModel|null,feed:FeedState):ExecutionStatus{
 if(!jobs)return {enabled:false,diagnostic:feed.status==='loading'?'loading':'unavailable',label:feed.status==='loading'?'Reading execution state…':'Execution state unavailable',tone:'idle'};
 const known=EXECUTION_LABELS[jobs.execution.diagnostic]??{label:jobs.execution.diagnostic,tone:'idle' as SignalTone};
 return {enabled:jobs.execution.enabled,diagnostic:jobs.execution.diagnostic,...known};
}
function activeJob(row:JobRow,detail:JobDetailLike|undefined,workspace:Workspace,devices:RuntimeDeviceLike[],now:string):ActiveJob{
 const project=projectOf(workspace,row.record.spec.projectId),task=workspace.tasks.find(item=>item.id===row.record.spec.taskId)??null,events=detail?.events??[];
 const progress=latestEvent(events,'progress'),started=latestEvent(events,'started'),observed=latestEvent(events,'model_observed'),accepted=latestEvent(events,'accepted');
 const stage=progress?.details.stage??null;
 const stageLabel=stage?STAGE_LABELS[stage]??stage:started?'Started on the PC':accepted?'Accepted by the PC':row.status==='queued'?'Waiting for the PC to claim it':row.status==='cancelling'?'Cancellation requested':'Waiting for the first report';
 const provider=detail?.provider??providerForModel(row.record.spec.requestedModel);
 const startedAt=row.attempt?.startedAt??row.attempt?.createdAt??null,elapsed=startedAt?secondsBetween(startedAt,now):null;
 const device=row.attempt?devices.find(item=>item.device.id===row.attempt!.deviceId)??null:null;
 const {label,tone}=STATUS_LABELS[row.status];
 return {id:row.record.id,projectId:row.record.spec.projectId,projectName:project?.name??'Unknown project',projectColor:project?.color??'teal',taskId:row.record.spec.taskId,taskTitle:task?.title??'Task no longer in the plan',operation:row.record.spec.operation,operationLabel:operationLabel(row.record.spec.operation),status:row.status,statusLabel:label,tone,provider,providerLabel:PROVIDER_LABELS[provider],model:row.record.spec.requestedModel,observedModel:observed?.details.observedModel??started?.details.observedModel??null,deviceId:row.attempt?.deviceId??null,deviceLabel:device?.device.label??row.attempt?.deviceId??null,location:'pc',stage,stageLabel,completedUnits:progress?.details.completedUnits??null,totalUnits:progress?.details.totalUnits??null,percent:progress&&progress.details.totalUnits?percent(progress.details.completedUnits,progress.details.totalUnits):null,startedAt,elapsedSeconds:elapsed,timeoutSeconds:row.record.spec.timeoutSeconds,deadlineAt:row.attempt?.deadlineAt??null,timePercent:elapsed===null?null:percent(elapsed,row.record.spec.timeoutSeconds),lastEventAt:row.attempt?.lastEventAt??null,eventCount:events.length,diagnostic:row.attempt?.diagnostic??'ok',operationalRevision:row.operationalRevision};
}
function recentJob(row:JobRow,workspace:Workspace):RecentJob{
 const project=projectOf(workspace,row.record.spec.projectId),task=workspace.tasks.find(item=>item.id===row.record.spec.taskId)??null,provider=providerForModel(row.record.spec.requestedModel),{label,tone}=STATUS_LABELS[row.status];
 return {id:row.record.id,projectId:row.record.spec.projectId,projectName:project?.name??'Unknown project',projectColor:project?.color??'teal',taskTitle:task?.title??'Task no longer in the plan',operation:row.record.spec.operation,operationLabel:operationLabel(row.record.spec.operation),status:row.status,statusLabel:label,tone,provider,providerLabel:PROVIDER_LABELS[provider],model:row.record.spec.requestedModel,observedModel:row.result?.observedModel??null,modelVerified:row.result?row.result.modelVerified:null,finishedAt:row.attempt?.lastEventAt??row.record.createdAt,runtimeSeconds:row.result?.usage?.runtimeSeconds??null,tokens:row.result?.usage?{input:row.result.usage.inputTokens,output:row.result.usage.outputTokens}:null,accepted:row.accepted,artifacts:row.result?.artifactIds.length??0,diagnostic:row.result?.diagnostic??row.attempt?.diagnostic??'ok'};
}
function personalJob(job:PersonalConnectorJob,connector:PersonalConnectorView,workspace:Workspace):PersonalJob{
 const project=projectOf(workspace,job.projectId),repository=connector.repositories.find(row=>row.key===job.repositoryKey)??null,active=job.status==='queued'||job.status==='claimed';
 const labels:Record<PersonalConnectorJob['status'],{label:string;tone:SignalTone}>={queued:{label:'Queued on this PC',tone:'live'},claimed:{label:'Running on this PC',tone:'live'},completed:{label:'Completed on this PC',tone:'good'},failed:{label:'Failed on this PC',tone:'bad'},cancelled:{label:'Cancelled',tone:'idle'}};
 const what=job.kind==='analyze'?`Analysis${repository?` of ${repository.name}`:''}`:job.kind==='brief'?`Briefing${repository?` of ${repository.name}`:''}${job.origin==='auto'?' (kept current)':''}`:job.kind==='browse'?'Folder picker':job.kind;
 return {id:job.id,kind:job.kind,status:job.status,projectId:job.projectId??null,projectName:project?.name??null,repositoryName:repository?.name??null,provider:job.provider??null,providerLabel:job.provider?PROVIDER_LABELS[job.provider]:null,createdAt:job.createdAt,claimedAt:job.claimedAt??null,active,tone:labels[job.status].tone,label:`${what} · ${labels[job.status].label}`};
}
function analysis(localReports:SavedReportLike<LocalAnalysisReport>[],cloudReports:SavedReportLike<GithubAnalysisReport>[],projectId:string):ProjectAnalysis|null{
 const local=localReports.filter(row=>row.projectId===projectId).sort((a,b)=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt))[0]??null;
 const cloud=cloudReports.filter(row=>row.projectId===projectId).sort((a,b)=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt))[0]??null;
 const useLocal=local&&(!cloud||Date.parse(local.recordedAt)>=Date.parse(cloud.recordedAt));
 if(useLocal&&local){
  const report=local.report,chats=report.chatContext?report.chatContext.sources.map(source=>({provider:source.provider,label:PROVIDER_LABELS[source.provider],status:source.status,statusLabel:CHAT_STATUS[source.status],latestAt:source.latestAt,messages:source.messages,characters:source.characters,truncated:source.truncated})):null;
  return {kind:'local',kindLabel:report.run.source==='personal-pc-connector'?'Local repository · personal PC app':'Local repository · paired helper',provider:report.run.provider,providerLabel:PROVIDER_LABELS[report.run.provider],model:report.run.requestedModel,observedModel:report.run.observedModel,recordedAt:local.recordedAt,completedAt:report.run.completedAt,repositoryName:report.repository.name,head:report.repository.head,dirty:report.repository.dirty,summary:report.summary,excerpt:excerpt(report.summary,220),suggestedTasks:report.suggestedTasks.length,findings:report.findings.length,chats,chatCharacters:report.chatContext?.includedCharacters??null};
 }
 if(cloud){
  const report=cloud.report;
  return {kind:'cloud',kindLabel:'GitHub repository · Codex Cloud handoff',provider:'codex',providerLabel:PROVIDER_LABELS.codex,model:report.run.requestedModel,observedModel:report.run.observedModel,recordedAt:cloud.recordedAt,completedAt:report.run.completedAt,repositoryName:report.repository.fullName,head:report.repository.head,dirty:null,summary:report.summary,excerpt:excerpt(report.summary,220),suggestedTasks:report.suggestedTasks.length,findings:report.findings.length,chats:null,chatCharacters:null};
 }
 return null;
}
const plural=(count:number,noun:string,many=noun+'s')=>`${count} ${count===1?noun:many}`;
function evidenceLine(report:ProjectBriefing):string{
 const e=report.evidence,parts:string[]=[];
 parts.push(`${plural(e.local.commits,'local commit')} on ${plural(e.local.branches,'branch','branches')}${e.local.uncommittedFiles?` and ${plural(e.local.uncommittedFiles,'uncommitted file')}`:''}`);
 if(e.cloud.status==='no-remote')parts.push('no GitHub remote');
 else if(e.cloud.status==='unavailable')parts.push('GitHub could not be reached from your PC');
 else parts.push(`${plural(e.cloud.commits,'cloud commit')} on ${plural(e.cloud.branches,'GitHub branch','GitHub branches')}${e.cloud.pullRequests!==null?`, ${e.cloud.openPullRequests??0} open of ${plural(e.cloud.pullRequests,'pull request')}`:''}${e.cloud.status==='stale'?' (as last fetched)':''}`);
 const chats=e.chats.filter(chat=>chat.status==='included').map(chat=>`${plural(chat.sessions,`${PROVIDER_LABELS[chat.provider]} chat`)}`);
 parts.push(chats.length?chats.join(' and '):'no recent local chats');
 if(e.ownerTurns.turns>0)parts.push(`${plural(e.ownerTurns.turns,'message')} of your own across ${plural(e.ownerTurns.sessions,'chat')}`);
 if(e.cloudTurns)for(const provider of ['claude-cloud','codex-cloud'] as const){
  const label=provider==='claude-cloud'?'Claude Code':'Codex',coverage=e.cloudTurns.find(row=>row.provider===provider);
  parts.push(coverage?.status==='included'?`${plural(coverage.turns,'owner turn')} across ${plural(coverage.sessions,`${label} cloud session`)}`:`no ${label} cloud sessions were available${coverage?.status==='unavailable'?' (unreadable or excluded)':''}`);
 }else parts.push('cloud chat coverage was not recorded in this saved briefing');
 if(e.framing){
  parts.push(e.framing.characters>0?'Measured against your framing':'No framing written yet');
  parts.push(e.framing.includeTaskPlan?`Task plan included: ${e.framing.includedMilestones} of ${plural(e.framing.totalMilestones,'milestone')} and ${e.framing.includedTasks} of ${plural(e.framing.totalTasks,'task')}`:'Task plan excluded');
 }
 if(e.previous)parts.push(`carried forward from the briefing of ${e.previous.until.slice(0,10)}`);
 return parts.join(' · ');
}
function ledgerOf(report:ProjectBriefing|null):BriefingLedger{
 if(!report)return {intentions:[],areas:[],links:[],aimArea:null,newSince:null,bends:0};
 const newSince=report.evidence.previous?.until??null,horizon=newSince?Date.parse(newSince):null;
 const areas=report.areas.map(area=>({id:area.id,name:area.name,state:area.state,stateLabel:AREA_STATE[area.state].label,tone:AREA_STATE[area.state].tone,done:area.done,total:area.total,note:area.note,isAim:report.aimArea===area.id,repositoryName:area.repositoryKey?report.repositories?.find(row=>row.key===area.repositoryKey)?.name??null:null}));
 const names=new Map(areas.map(area=>[area.id,area.name]));
 const intentions=report.intentions.map(row=>({date:row.date,title:row.title,outcome:row.outcome,state:row.state,stateLabel:INTENTION_STATE[row.state].label,tone:INTENTION_STATE[row.state].tone,sourceLabel:row.source==='cloud'&&row.cloudProvider?`a ${row.cloudProvider==='claude-cloud'?'Claude Code':'Codex'} cloud chat`:INTENTION_SOURCE[row.source],areaId:row.area,areaName:row.area?names.get(row.area)??null:null,bend:row.bend,evidence:row.evidence,isNew:horizon!==null&&row.date!==null&&Date.parse(row.date+'T23:59:59.999Z')>horizon}));
 return {intentions,areas,links:report.links,aimArea:report.aimArea,newSince,bends:intentions.filter(row=>row.bend).length};
}
function briefingView(project:Project,saved:SavedProjectBriefing[],_localReports:SavedReportLike<LocalAnalysisReport>[],connector:PersonalConnectorView|null,connectorState:ConnectorStatus['state']):BriefingView{
 const rows=saved.filter(row=>row.projectId===project.id).sort((a,b)=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt)),latestSaved=rows[0]??null;
 let completed:{requestId:string;briefingSha256:string;briefing:ProjectBriefing}|null=null;
 if(connector?.completedBriefing&&connector.completedBriefing.projectId===project.id){try{completed={requestId:connector.completedBriefing.requestId,briefingSha256:connector.completedBriefing.briefingSha256,briefing:validateProjectBriefing(connector.completedBriefing.briefing)};}catch{completed=null;}}
 const useCompleted=completed&&(!latestSaved||completed.briefing.run.id!==latestSaved.briefing.run.id&&Date.parse(completed.briefing.run.completedAt)>=Date.parse(latestSaved.briefing.run.completedAt));
 const report=useCompleted?completed!.briefing:latestSaved?.briefing??null;
 const jobs=(connector?.jobs??[]).filter(job=>job.kind==='brief'&&job.projectId===project.id).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
 const active=jobs.find(job=>job.status==='queued'||job.status==='claimed')??null;
 const failed=jobs[0]&&jobs[0].status==='failed'&&(!report||Date.parse(jobs[0].createdAt)>Date.parse(report.run.completedAt))?jobs[0]:null;
 const policies=(connector?.policies??[]).filter(policy=>policy.projectId===project.id);
 const choices=(connector?.repositories??[]).map(({key,name})=>({key,name}));
 const known=(key:string|null|undefined)=>key&&choices.some(row=>row.key===key)?key:null;
 const boundKeys=project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[]);
 const boundFolderUnavailable=Boolean(connector)&&boundKeys.some(key=>!known(key));
 const policy=policies[0]??null;
 const repositoryKey=boundKeys.length?known(boundKeys[0]):null;
 const repositories=boundKeys.map(key=>({key,name:choices.find(row=>row.key===key)?.name??report?.repositories?.find(row=>row.key===key)?.name??key}));
 const repositoryName=repositories[0]?.name??report?.repository.name??null;
 const providers=(['codex','claude'] as const).map(id=>({id,label:PROVIDER_LABELS[id],ready:connector?.providers[id].ready??false}));
 const reportedRepositories=report?.repositories??(report?[report.repository]:[]);
 const changedFolderNames=report?repositories.filter(repository=>{const previous=reportedRepositories.find(row=>row.key===repository.key),live=connector?.repositories.find(row=>row.key===repository.key);return !previous||live&&(live.head!==previous.head||live.dirty!==previous.dirty);}).map(repository=>repository.name):[];
 const addedFolderNames=report?repositories.filter(repository=>!reportedRepositories.some(row=>row.key===repository.key)).map(row=>row.name):[];
 const newWork=changedFolderNames.length>0;
 const state:BriefingView['state']=active?(active.status==='claimed'?'running':'queued'):report?'ready':'none';
 const requestHint=active?null:boundFolderUnavailable?'The linked folder is unavailable on your PC. Restore it under Repositories before requesting a briefing.':connectorState!=='online'?(connectorState==='unconfigured'?'Connect your PC under Repositories to brief this project.':connectorState==='disconnected'?'Reconnect your PC under Repositories to brief this project.':'Start Control Room on your PC to brief this project.'):!repositoryKey?(choices.length?'Add the folders on your PC that belong to this project.':'Choose this project\'s folder under Repositories first.'):!providers.some(row=>row.ready)?'Sign in to Codex or Claude Code on your PC first.':null;
 return {state,report,source:report?(useCompleted?'completed':'saved'):null,recordedAt:report?(useCompleted?report.run.completedAt:latestSaved!.recordedAt):null,version:useCompleted?null:latestSaved?.version??null,evidenceId:useCompleted?null:latestSaved?.evidenceId??null,
  unsaved:useCompleted?{requestId:completed!.requestId,briefingSha256:completed!.briefingSha256}:null,
  status:report?{level:report.status.level,...BRIEFING_STATUS[report.status.level]}:{level:null,label:state==='none'?'No briefing yet':'Briefing in progress',tone:state==='none'?'idle':'live'},
  ledger:ledgerOf(report),
  freshness:{newWork,detail:newWork?`New commits, uncommitted changes or folders awaiting coverage: ${changedFolderNames.join(', ')}.${addedFolderNames.length?` Added since this briefing: ${addedFolderNames.join(', ')}.`:''}`:null,basedOnAt:report?.evidence.window.until??null},
  repositories,changedFolderNames,evidenceCoverage:(report?.evidence.repositories??[]).map(row=>({key:row.key,name:row.name,line:evidenceLine({...report!,evidence:{...report!.evidence,...row,repositories:[row]}})})),
  evidenceLine:report?evidenceLine(report):'',providerLabel:report?PROVIDER_LABELS[report.run.provider]:null,originLabel:report?(report.run.origin==='auto'?'kept current automatically':'on your request'):null,
  repositoryKey,repositoryName,repositoryChoices:boundFolderUnavailable?[]:choices,policy:policy?{repositoryKey:policy.repositoryKey,provider:policy.provider,enabled:policy.enabled,minIntervalMinutes:policy.minIntervalMinutes,lastBriefAt:policy.lastBriefAt}:null,
  providers,connector:connectorState,canRequest:boundKeys.length>0&&!boundFolderUnavailable&&connectorState==='online'&&providers.some(row=>row.ready)&&!active,requestHint,
  activeJob:active?{id:active.id,status:active.status as 'queued'|'claimed',providerLabel:active.provider?PROVIDER_LABELS[active.provider]:'Assistant',origin:active.origin??'owner',createdAt:active.createdAt,claimedAt:active.claimedAt??null}:null,
  lastFailure:failed?{at:failed.claimedAt??failed.createdAt,providerLabel:failed.provider?PROVIDER_LABELS[failed.provider]:'Assistant',reason:personalJobFailureReason(failed.error,'brief')??BRIEF_FAILURES[failed.error??'']??'it did not finish',standalone:personalJobFailureReason(failed.error,'brief')!==null}:null};
}
function logEntry(entry:Activity,workspace:Workspace):LogEntry{const project=projectOf(workspace,entry.projectId);return {id:entry.id,text:entry.text,at:entry.at,projectId:entry.projectId,projectName:project?.name??null,projectColor:project?.color??null};}

export function buildDashboardModel(input:DashboardInputs):DashboardModel{
 const {workspace,now}=input,today=cairoDate(now),devices=(input.runtime?.devices??[]);
 const jobRows=input.jobs?.jobs??[];
 const activeRows=jobRows.filter(row=>ACTIVE_JOB_STATUSES.includes(row.status)&&!row.record.historical).sort((a,b)=>(ACTIVE_ORDER[a.status]??9)-(ACTIVE_ORDER[b.status]??9)||Date.parse(b.record.createdAt)-Date.parse(a.record.createdAt));
 const active=activeRows.map(row=>activeJob(row,input.jobDetails[row.record.id],workspace,devices,now));
 const recent=jobRows.filter(row=>TERMINAL_JOB_STATUSES.includes(row.status)).map(row=>recentJob(row,workspace)).sort((a,b)=>Date.parse(b.finishedAt??'')-Date.parse(a.finishedAt??'')).slice(0,8);
 const personal=input.connector?input.connector.jobs.map(job=>personalJob(job,input.connector!,workspace)).sort((a,b)=>Number(b.active)-Number(a.active)||Date.parse(b.createdAt)-Date.parse(a.createdAt)):[];
 const awaiting=jobRows.filter(row=>row.status==='awaiting_approval'&&!row.record.historical),reconcile=jobRows.filter(row=>row.status==='reconcile_required');
 const counts={running:active.filter(job=>job.status==='running'||job.status==='leased').length,queued:active.filter(job=>job.status==='queued').length,cancelling:active.filter(job=>job.status==='cancelling').length,awaitingApproval:awaiting.length,reconcile:reconcile.length,personalActive:personal.filter(job=>job.active).length};
 const working=counts.running+counts.personalActive,agentParts=[working?`${working} working`:'',counts.queued?`${counts.queued} queued`:'',counts.awaitingApproval?`${counts.awaitingApproval} awaiting approval`:'',counts.reconcile?`${counts.reconcile} to reconcile`:''].filter(Boolean);
 const agents={...counts,label:agentParts.length?agentParts.join(' · '):'No agent working',tone:(working?'live':counts.awaitingApproval||counts.reconcile||counts.cancelling?'warn':'idle') as SignalTone};
 const recommendations=getRecommendations(workspace,today),connectorState=connectorStatus(input.connector,input.feeds.connector,now).state;
 const projects=workspace.projects.filter(project=>!project.archivedAt).map((project):ProjectTile=>{
  const tasks=workspace.tasks.filter(task=>task.projectId===project.id&&task.status!=='archived'&&!archivedEntity(workspace,{kind:'task',id:task.id}));
  const milestones=workspace.milestones.filter(milestone=>milestone.projectId===project.id&&!milestone.archivedAt);
  const open=tasks.filter(openTask),done=tasks.filter(task=>task.status==='done').length,milestonesDone=milestones.filter(milestone=>milestone.status==='achieved').length;
  const progress:ProjectProgress={milestonesDone,milestonesTotal:milestones.length,milestonePercent:percent(milestonesDone,milestones.length),tasksDone:done,tasksOpen:open.length,tasksTotal:tasks.length,taskPercent:percent(done,tasks.length),inProgress:open.filter(task=>task.status==='doing').length,inReview:open.filter(task=>task.status==='review').length,proposed:open.filter(task=>task.status==='proposed').length,blocked:open.filter(task=>getBlockers(task,workspace).length>0).length,weeklyPinned:open.filter(task=>isCurrentWeek(task,now)).length,overdue:open.filter(task=>task.dueDate!==null&&task.dueDate<today).length};
  const current:Milestone|undefined=milestones.find(milestone=>milestone.status==='active')??[...milestones].sort((a,b)=>a.sortKey-b.sortKey).find(milestone=>milestone.status==='planned');
  const jobs=active.filter(job=>job.projectId===project.id),personalJobs=personal.filter(job=>job.projectId===project.id&&job.active);
  const state:ProjectAgentState=jobs.some(job=>job.status==='running'||job.status==='leased')||personalJobs.length?'running':jobs.some(job=>job.status==='cancelling')?'cancelling':jobs.length?'queued':reconcile.some(row=>row.record.spec.projectId===project.id)?'reconcile':awaiting.some(row=>row.record.spec.projectId===project.id)?'awaiting_approval':'idle';
  const agentLabels:Record<ProjectAgentState,{label:string;tone:SignalTone}>={running:{label:'Agent working now',tone:'live'},cancelling:{label:'Agent cancelling',tone:'warn'},queued:{label:'Agent queued',tone:'live'},reconcile:{label:'Run needs reconciliation',tone:'warn'},awaiting_approval:{label:'Awaiting your approval',tone:'warn'},idle:{label:'No agent working',tone:'idle'}};
  const projectJobs=jobRows.filter(row=>row.record.spec.projectId===project.id),withResult=projectJobs.filter(row=>row.result);
  const tokens={input:withResult.reduce((sum,row)=>sum+(row.result!.usage?.inputTokens??0),0),output:withResult.reduce((sum,row)=>sum+(row.result!.usage?.outputTokens??0),0),runs:withResult.length,reported:withResult.filter(row=>row.result!.usage&&(row.result!.usage.inputTokens!==null||row.result!.usage.outputTokens!==null)).length};
  const activity=workspace.activity.filter(entry=>entry.projectId===project.id).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,3).map(entry=>logEntry(entry,workspace));
  const recommendation=recommendations.map(row=>({row,task:workspace.tasks.find(task=>task.id===row.taskId)})).find(item=>item.task?.projectId===project.id);
  const lastRunAt=projectJobs.map(row=>row.attempt?.lastEventAt??row.record.createdAt).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null;
  return {project,progress,level:1+milestonesDone+Math.floor(done/5),milestone:current?{id:current.id,title:current.title,status:current.status,targetDate:current.targetDate}:null,agent:{state,...agentLabels[state],jobs,personal:personalJobs},analysis:analysis(input.localReports,input.cloudReports,project.id),briefing:briefingView(project,input.briefings,input.localReports,input.connector,connectorState),activity,nextAction:recommendation?.task?{task:recommendation.task,reason:recommendation.row.reason}:null,tokens,lastRunAt,lastActivityAt:activity[0]?.at??null};
 });
 const attention:AttentionItem[]=[];
 for(const task of workspace.tasks.filter(task=>task.status==='review'&&!archivedEntity(workspace,{kind:'task',id:task.id}))){const project=projectOf(workspace,task.projectId);attention.push({key:`review:${task.id}`,kind:'review',title:task.title,detail:'Waiting for your review decision',projectId:task.projectId,projectName:project?.name??null,taskId:task.id,tone:'warn'});}
 for(const row of awaiting){const project=projectOf(workspace,row.record.spec.projectId),task=workspace.tasks.find(item=>item.id===row.record.spec.taskId);attention.push({key:`approval:${row.record.id}`,kind:'approval',title:`${operationLabel(row.record.spec.operation)} · ${task?.title??row.record.spec.taskId}`,detail:'Agent job proposal waiting for approval',projectId:row.record.spec.projectId,projectName:project?.name??null,jobId:row.record.id,tone:'warn'});}
 for(const row of reconcile){const project=projectOf(workspace,row.record.spec.projectId),task=workspace.tasks.find(item=>item.id===row.record.spec.taskId);attention.push({key:`reconcile:${row.record.id}`,kind:'reconcile',title:`${operationLabel(row.record.spec.operation)} · ${task?.title??row.record.spec.taskId}`,detail:'Execution outcome is uncertain and needs reconciliation',projectId:row.record.spec.projectId,projectName:project?.name??null,jobId:row.record.id,tone:'bad'});}
 for(const task of workspace.tasks.filter(task=>openTask(task)&&task.dueDate!==null&&task.dueDate<today&&!archivedEntity(workspace,{kind:'task',id:task.id}))){const project=projectOf(workspace,task.projectId);attention.push({key:`overdue:${task.id}`,kind:'overdue',title:task.title,detail:`Overdue since ${task.dueDate}`,projectId:task.projectId,projectName:project?.name??null,taskId:task.id,tone:'bad'});}
 for(const task of workspace.tasks.filter(task=>openTask(task)&&task.weekly&&!isCurrentWeek(task,now)&&!archivedEntity(workspace,{kind:'task',id:task.id}))){const project=projectOf(workspace,task.projectId);attention.push({key:`carry:${task.id}`,kind:'carry',title:task.title,detail:`Pinned in the week of ${task.weeklyWeek??'an earlier week'} and still open`,projectId:task.projectId,projectName:project?.name??null,taskId:task.id,tone:'idle'});}
 for(const tile of projects){const report=tile.briefing.report;if(!report)continue;report.needsYou.slice(0,3).forEach((text,index)=>attention.push({key:`decision:${tile.project.id}:${index}`,kind:'decision',title:text,detail:'Raised by the project briefing',projectId:tile.project.id,projectName:tile.project.name,tone:'warn'}));}
 const inbox=workspace.captures.filter(capture=>capture.status==='inbox').length;
 if(inbox)attention.push({key:'inbox',kind:'inbox',title:`${inbox} capture${inbox===1?'':'s'} in the inbox`,detail:'File, convert or archive them',projectId:null,projectName:null,tone:'idle'});
 // Severity first; carried-over pins are informational and sort after everything else.
 attention.sort((a,b)=>TONE_RANK[a.tone]-TONE_RANK[b.tone]||Number(a.kind==='carry')-Number(b.kind==='carry'));
 const attentionTotal=attention.filter(item=>item.kind!=='carry').length,attentionTone:SignalTone=attention.some(item=>item.tone==='bad')?'bad':attentionTotal?'warn':'idle';
 const log=[...workspace.activity].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,14).map(entry=>logEntry(entry,workspace));
 const execution=executionStatus(input.jobs,input.feeds.jobs);
 const cloudReportAt=input.cloudReports.map(row=>row.recordedAt).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null;
 return {now,today,hud:{pc:pcStatus(input.runtime,input.feeds.runtime,now),connector:connectorStatus(input.connector,input.feeds.connector,now),cloud:{execution,lastReportAt:cloudReportAt,reportCount:input.cloudReports.length},agents,attention:{total:attentionTotal,label:attentionTotal?`${attentionTotal} item${attentionTotal===1?'':'s'} need you`:'Nothing waiting on you',tone:attentionTone}},projects,operations:{active,recent,personal,execution},attention,log,feeds:input.feeds};
}
