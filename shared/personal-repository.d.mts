import type {LocalAnalysisReport} from './local-analysis.mjs';
import type {CompactPlan,ProjectBriefing} from './project-briefing.mjs';
export type PersonalProvider='codex'|'claude';
export interface PersonalRepository {key:string;name:string;head:string;dirty:boolean;hasPreviousAnalysis:boolean}
export type PersonalProviders=Record<PersonalProvider,{ready:boolean;detail:'ready'|'not_installed'|'auth_required'|'unavailable'}>;
export interface PersonalJob {id:string;kind:'browse'|'analyze'|'brief';status:'queued'|'claimed'|'completed'|'failed'|'cancelled';createdAt:string;expiresAt:string;claimedAt:string|null;projectId?:string;repositoryKey?:string;provider?:PersonalProvider;requestedModel?:string;report?:LocalAnalysisReport;briefing?:ProjectBriefing;plan?:CompactPlan;origin?:'owner'|'auto';fingerprint?:string;reportSha256?:string;error?:string;consumedAt?:string}
export interface PersonalPolicy {repositoryKey:string;projectId:string;provider:PersonalProvider;enabled:boolean;minIntervalMinutes:number;updatedAt:string;lastBriefAt:string|null;lastAttemptAt:string|null;lastFingerprint:string|null}
export interface PersonalState {version:1;deviceId:string;connected:boolean;epoch:number;lastSeenAt:string|null;providers:PersonalProviders;repositories:PersonalRepository[];requests:PersonalJob[];policies:PersonalPolicy[]}
export type PersonalOwnerAction={action:'browse';requestId:string}|{action:'analyze';requestId:string;projectId:string;repositoryKey:string;provider:PersonalProvider}|{action:'brief';requestId:string;projectId:string;repositoryKey:string;provider:PersonalProvider}|{action:'cancel';requestId:string}|{action:'connect'|'disconnect'|'clear-finished'}|{action:'ack';requestId:string;runId:string;reportSha256:string}|{action:'keep-current';repositoryKey:string;projectId:string;provider:PersonalProvider;enabled:boolean;minIntervalMinutes?:number};
export type PersonalDeviceAction={action:'poll';providers?:PersonalProviders;repositories?:PersonalRepository[]}|{action:'complete';requestId:string;repositories?:PersonalRepository[];report?:LocalAnalysisReport;briefing?:ProjectBriefing;fingerprint?:string}|{action:'fail';requestId:string;error:string}|{action:'auto-brief';requestId:string;repositoryKey:string;fingerprint:string};
export const PERSONAL_LIMITS:Readonly<{repositories:16;claimMs:300000;briefMs:600000;queueMs:600000;bodyBytes:65536;stateBytes:500000;policies:16;minIntervalMinutes:30;maxIntervalMinutes:1440;defaultIntervalMinutes:120}>;
export function parseOwnerAction(value:unknown):PersonalOwnerAction;
export function parseDeviceAction(value:unknown):PersonalDeviceAction;
export function parseProviders(value:unknown):PersonalProviders;
export function parseRepositories(value:unknown):PersonalRepository[];
export function parsePolicies(value:unknown):PersonalPolicy[];
export function initialPersonalState(deviceId:string):PersonalState;
export function validatePersonalState(value:unknown):PersonalState;
export function transitionPersonalState(state:PersonalState,action:PersonalOwnerAction|PersonalDeviceAction,now:string,actor:'owner'|'device',context?:{plan?:CompactPlan}):PersonalState;
