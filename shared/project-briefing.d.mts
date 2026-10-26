import type {Workspace} from '../lib/types.ts';
export type BriefingProvider='codex'|'claude';
export type BriefingStatusLevel='on-track'|'at-risk'|'blocked'|'paused'|'unclear';
export type BriefingWorkOutcome='finished'|'unfinished'|'unclear';
export type BriefingWorkPlace='local'|'cloud'|'both'|'chat';
export type BriefingAreaState='proven'|'built'|'partial'|'open'|'paused'|'blocked'|'none';
export type BriefingIntentionState='reached'|'negative'|'changed'|'paused'|'not-reached'|'in-progress'|'open';
export type BriefingIntentionSource='local-codex'|'local-claude'|'cloud'|'plan'|'repository'|'unknown';
export type BriefingCloudProvider='claude-cloud'|'codex-cloud';
/** Version 1 content, still accepted on read and projected to version 3. */
export interface BriefingContentV1 {
 headline:string;status:{level:BriefingStatusLevel;reason:string};
 recentWork:{title:string;outcome:BriefingWorkOutcome;when:string|null;where:BriefingWorkPlace;detail:string;evidence:string[]}[];
 unfinished:{title:string;remaining:string;where:BriefingWorkPlace}[];
 done:string[];notDone:string[];decisionsNeeded:string[];nextSteps:string[];limitations:string[];
}
export interface BriefingArea {repositoryKey?:string;id:string;name:string;state:BriefingAreaState;done:number;total:number;note:string}
export interface BriefingLink {from:string;to:string}
export interface BriefingBend {from:string;to:string;why:string}
export type BriefingEvidenceRef=string|{repositoryKey:string;ref:string};
export interface BriefingIntention {repositoryKey?:string;date:string|null;title:string;outcome:string;state:BriefingIntentionState;source:BriefingIntentionSource;cloudProvider?:BriefingCloudProvider;area:string|null;bend:BriefingBend|null;evidence:BriefingEvidenceRef[]}
export interface BriefingContentV2 {
 aim:string;status:{level:BriefingStatusLevel;reason:string};leftOff:string[];
 areas:BriefingArea[];links:BriefingLink[];aimArea:string|null;
 intentions:BriefingIntention[];
 open:string[];needsYou:string[];tried:string[];done:string[];notDone:string[];nextSteps:string[];limitations:string[];
}
export interface BriefingContent extends BriefingContentV2 {fitOrDrift:string}
export interface BriefingEvidenceV1 {
 window:{since:string;until:string};
 local:{branch:string|null;commits:number;branches:number;latestCommitAt:string|null;uncommittedFiles:number};
 cloud:{status:'fetched'|'stale'|'unavailable'|'no-remote';remote:string|null;branches:number;commits:number;latestCommitAt:string|null;pullRequests:number|null;openPullRequests:number|null;fetchedAt:string|null};
 chats:{provider:BriefingProvider;status:'included'|'not-found'|'unavailable';sessions:number;messages:number;latestAt:string|null}[];
 plan:{revision:number;milestones:number;tasks:number}|null;
 inputSha256:string;
}
export interface BriefingEvidenceV2 extends BriefingEvidenceV1 {
 ownerTurns:{sessions:number;turns:number;characters:number;earliestAt:string|null;latestAt:string|null};
 cloudTurns?:{provider:BriefingCloudProvider;status:'included'|'not-found'|'unavailable';sessions:number;turns:number}[];
 previous:{runId:string;until:string;intentions:number}|null;
}
export interface BriefingRepositoryCoverage {key:string;name:string;local:BriefingEvidenceV1['local'];cloud:BriefingEvidenceV1['cloud'];chats:BriefingEvidenceV1['chats'];ownerTurns:BriefingEvidenceV2['ownerTurns'];cloudTurns?:BriefingEvidenceV2['cloudTurns']}
export interface BriefingEvidence extends Omit<BriefingEvidenceV2,'plan'> {repositories:BriefingRepositoryCoverage[];framing:{workspaceRevision:number;characters:number;includeTaskPlan:boolean;totalMilestones:number;totalTasks:number;includedMilestones:number;includedTasks:number}|null}
export interface BriefingIdentity {
 project:{id:string;name:string};
 repository:{key:string;name:string;head:string;branch:string|null;dirty:boolean};
 run:{id:string;provider:BriefingProvider;requestedModel:'gpt-6.1-sol'|'claude-code-default';observedModel:string|null;startedAt:string;completedAt:string;mode:'read-only';source:'personal-pc-connector';origin:'owner'|'auto'};
}
export interface ProjectBriefingV1 extends BriefingContentV1,BriefingIdentity {format:'control-room-project-briefing';version:1;evidence:BriefingEvidenceV1}
export interface ProjectBriefingV2 extends BriefingContentV2,BriefingIdentity {format:'control-room-project-briefing';version:2;evidence:BriefingEvidenceV2}
export interface ProjectBriefing extends BriefingContent,BriefingIdentity {format:'control-room-project-briefing';version:4;repositories:BriefingIdentity['repository'][];evidence:BriefingEvidence}
export interface PreviousLedger {runId:string;until:string;aim:string;fitOrDrift:string;areas:BriefingArea[];links:BriefingLink[];aimArea:string|null;intentions:BriefingIntention[];open:string[];needsYou:string[]}
export interface CompactPlan {
 revision:number;project:{id:string;name:string;goal:string;description:string};
 milestones:{title:string;status:'planned'|'active'|'achieved';targetDate:string|null}[];
 tasks:{title:string;status:'proposed'|'todo'|'doing'|'review'|'done';horizon:'now'|'next'|'later';dueDate:string|null;milestone:number|null;blocked:boolean;completedAt:string|null}[];
 totals:{tasks:number;open:number;done:number;omitted:number};
}
export const PROJECT_BRIEFING_MARKER:'control-room-project-briefing-v1';
export const PROJECT_BRIEFING_VERSION:4;
export const PROJECT_FRAMING_MAX_CHARACTERS:10000;
export const LEGACY_FIT_OR_DRIFT:string;
export const PROJECT_BRIEFING_MAX_CHARACTERS:32200;
export const PREVIOUS_LEDGER_MAX_CHARACTERS:14000;
export const COMPACT_PLAN_MAX_CHARACTERS:6000;
export const BRIEFING_PROVIDERS:readonly BriefingProvider[];
export const BRIEFING_MODELS:Readonly<Record<BriefingProvider,'gpt-6.1-sol'|'claude-code-default'>>;
export const BRIEFING_STATUS_LEVELS:readonly BriefingStatusLevel[];
export const BRIEFING_WORK_OUTCOMES:readonly BriefingWorkOutcome[];
export const BRIEFING_WORK_PLACES:readonly BriefingWorkPlace[];
export const BRIEFING_AREA_STATES:readonly BriefingAreaState[];
export const BRIEFING_INTENTION_STATES:readonly BriefingIntentionState[];
export const BRIEFING_INTENTION_SOURCES:readonly BriefingIntentionSource[];
export const BRIEFING_CLOUD_PROVIDERS:readonly BriefingCloudProvider[];
export const briefingContentSchema:Record<string,unknown>;
export const briefingContentSchemaV1:Record<string,unknown>;
export const briefingEvidenceSchema:Record<string,unknown>;
export const briefingEvidenceSchemaV1:Record<string,unknown>;
export const projectBriefingSchema:Record<string,unknown>;
export const projectBriefingSchemaV1:Record<string,unknown>;
export const previousLedgerSchema:Record<string,unknown>;
export const compactPlanSchema:Record<string,unknown>;
export function validateBriefingContent(value:unknown):BriefingContent;
export function validateBriefingContentV1(value:unknown):BriefingContentV1;
export function validateBriefingEvidence(value:unknown):BriefingEvidence;
export function validateBriefingEvidenceV1(value:unknown):BriefingEvidenceV1;
export function upgradeBriefing(value:ProjectBriefingV1):ProjectBriefing;
export function validateProjectBriefing(value:unknown):ProjectBriefing;
export function previousLedger(value:unknown):PreviousLedger;
export function validatePreviousLedger(value:unknown):PreviousLedger;
export function validateCompactPlan(value:unknown):CompactPlan;
export function compactPlan(workspace:Workspace,projectId:string,revision:number):CompactPlan;

export interface ProjectFraming {projectId:string;projectName:string;framing:string;includeTaskPlan:boolean;milestones:CompactPlan['milestones'];tasks:CompactPlan['tasks'];totalMilestones:number;totalTasks:number;workspaceRevision:number}
export const projectFramingSchema:Record<string,unknown>;
export const briefingContentSchemaV2:Record<string,unknown>;
export const briefingEvidenceSchemaV2:Record<string,unknown>;
export const projectBriefingSchemaV2:Record<string,unknown>;
export function validateBriefingContentV2(value:unknown):BriefingContentV2;
export function validateBriefingEvidenceV2(value:unknown):BriefingEvidenceV2;
export function upgradeBriefingV2(value:ProjectBriefingV2):ProjectBriefing;
export function validateProjectFraming(value:unknown):ProjectFraming;
export function projectFraming(workspace:Workspace,projectId:string,workspaceRevision:number):ProjectFraming;

export interface ProjectBriefingV3 extends BriefingContent,BriefingIdentity {format:'control-room-project-briefing';version:3;evidence:Omit<BriefingEvidence,'repositories'>}
export function upgradeBriefingV3(value:ProjectBriefingV3):ProjectBriefing;
export const projectBriefingSchemaV3:Record<string,unknown>;
export const briefingContentSchemaV3:Record<string,unknown>;
export const briefingEvidenceSchemaV3:Record<string,unknown>;
