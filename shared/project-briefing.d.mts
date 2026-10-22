import type {Workspace} from '../lib/types.ts';
export type BriefingProvider='codex'|'claude';
export type BriefingStatusLevel='on-track'|'at-risk'|'blocked'|'paused'|'unclear';
export type BriefingWorkOutcome='finished'|'unfinished'|'unclear';
export type BriefingWorkPlace='local'|'cloud'|'both'|'chat';
export interface BriefingContent {
 headline:string;status:{level:BriefingStatusLevel;reason:string};
 recentWork:{title:string;outcome:BriefingWorkOutcome;when:string|null;where:BriefingWorkPlace;detail:string;evidence:string[]}[];
 unfinished:{title:string;remaining:string;where:BriefingWorkPlace}[];
 done:string[];notDone:string[];decisionsNeeded:string[];nextSteps:string[];limitations:string[];
}
export interface BriefingEvidence {
 window:{since:string;until:string};
 local:{branch:string|null;commits:number;branches:number;latestCommitAt:string|null;uncommittedFiles:number};
 cloud:{status:'fetched'|'stale'|'unavailable'|'no-remote';remote:string|null;branches:number;commits:number;latestCommitAt:string|null;pullRequests:number|null;openPullRequests:number|null;fetchedAt:string|null};
 chats:{provider:BriefingProvider;status:'included'|'not-found'|'unavailable';sessions:number;messages:number;latestAt:string|null}[];
 plan:{revision:number;milestones:number;tasks:number}|null;
 inputSha256:string;
}
export interface ProjectBriefing extends BriefingContent {
 format:'control-room-project-briefing';version:1;
 project:{id:string;name:string};
 repository:{key:string;name:string;head:string;branch:string|null;dirty:boolean};
 run:{id:string;provider:BriefingProvider;requestedModel:'gpt-6.1-sol'|'claude-code-default';observedModel:string|null;startedAt:string;completedAt:string;mode:'read-only';source:'personal-pc-connector';origin:'owner'|'auto'};
 evidence:BriefingEvidence;
}
export interface CompactPlan {
 revision:number;project:{id:string;name:string;goal:string;description:string};
 milestones:{title:string;status:'planned'|'active'|'achieved';targetDate:string|null}[];
 tasks:{title:string;status:'proposed'|'todo'|'doing'|'review'|'done';horizon:'now'|'next'|'later';dueDate:string|null;milestone:number|null;blocked:boolean;completedAt:string|null}[];
 totals:{tasks:number;open:number;done:number;omitted:number};
}
export const PROJECT_BRIEFING_MARKER:'control-room-project-briefing-v1';
export const PROJECT_BRIEFING_MAX_CHARACTERS:9600;
export const COMPACT_PLAN_MAX_CHARACTERS:6000;
export const BRIEFING_PROVIDERS:readonly BriefingProvider[];
export const BRIEFING_MODELS:Readonly<Record<BriefingProvider,'gpt-6.1-sol'|'claude-code-default'>>;
export const BRIEFING_STATUS_LEVELS:readonly BriefingStatusLevel[];
export const BRIEFING_WORK_OUTCOMES:readonly BriefingWorkOutcome[];
export const BRIEFING_WORK_PLACES:readonly BriefingWorkPlace[];
export const briefingContentSchema:Record<string,unknown>;
export const briefingEvidenceSchema:Record<string,unknown>;
export const projectBriefingSchema:Record<string,unknown>;
export const compactPlanSchema:Record<string,unknown>;
export function validateBriefingContent(value:unknown):BriefingContent;
export function validateBriefingEvidence(value:unknown):BriefingEvidence;
export function validateProjectBriefing(value:unknown):ProjectBriefing;
export function validateCompactPlan(value:unknown):CompactPlan;
export function compactPlan(workspace:Workspace,projectId:string,revision:number):CompactPlan;
