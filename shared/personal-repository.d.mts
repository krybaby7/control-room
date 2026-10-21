import type {LocalAnalysisReport} from './local-analysis.mjs';
export type PersonalProvider='codex'|'claude';
export interface PersonalRepository {key:string;name:string;head:string;dirty:boolean;hasPreviousAnalysis:boolean}
export type PersonalProviders=Record<PersonalProvider,{ready:boolean;detail:'ready'|'not_installed'|'auth_required'|'unavailable'}>;
export interface PersonalJob {id:string;kind:'browse'|'analyze';status:'queued'|'claimed'|'completed'|'failed'|'cancelled';createdAt:string;expiresAt:string;claimedAt:string|null;projectId?:string;repositoryKey?:string;provider?:PersonalProvider;requestedModel?:string;report?:LocalAnalysisReport;reportSha256?:string;error?:string;consumedAt?:string}
export interface PersonalState {version:1;deviceId:string;connected:boolean;epoch:number;lastSeenAt:string|null;providers:PersonalProviders;repositories:PersonalRepository[];requests:PersonalJob[]}
export type PersonalOwnerAction={action:'browse';requestId:string}|{action:'analyze';requestId:string;projectId:string;repositoryKey:string;provider:PersonalProvider}|{action:'cancel';requestId:string}|{action:'connect'|'disconnect'|'clear-finished'}|{action:'ack';requestId:string;runId:string;reportSha256:string};
export type PersonalDeviceAction={action:'poll';providers?:PersonalProviders;repositories?:PersonalRepository[]}|{action:'complete';requestId:string;repositories?:PersonalRepository[];report?:LocalAnalysisReport}|{action:'fail';requestId:string;error:string};
export const PERSONAL_LIMITS:Readonly<{repositories:16;jobs:20;claimMs:300000;queueMs:600000;bodyBytes:65536;stateBytes:500000}>;
export function parseOwnerAction(value:unknown):PersonalOwnerAction;
export function parseDeviceAction(value:unknown):PersonalDeviceAction;
export function parseProviders(value:unknown):PersonalProviders;
export function parseRepositories(value:unknown):PersonalRepository[];
export function initialPersonalState(deviceId:string):PersonalState;
export function validatePersonalState(value:unknown):PersonalState;
export function transitionPersonalState(state:PersonalState,action:PersonalOwnerAction|PersonalDeviceAction,now:string,actor:'owner'|'device'):PersonalState;



