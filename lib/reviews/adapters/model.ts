import type {ReviewAnalysis} from '../contracts.ts';
/** Implementations are injected server adapters. This module contains no provider SDK or network client. */
export interface AnalysisRequest {
 requestId:string;provider:string;model:string;snapshotId:string;snapshotHash:string;
 inputDigest:string;input:string;maxOutputTokens:number;signal:AbortSignal;
}
export interface AnalysisQuote {
 requestId:string;provider:string;model:string;inputDigest:string;maxOutputTokens:number;
 upperBoundCostDollars:number;guaranteed:true;expiresAt:string;
}
export interface ReviewModelAdapter {
 capabilities(request:{provider:string;model:string;signal:AbortSignal}):Promise<{
  provider:string;model:string;available:boolean;supportsIdempotency:boolean;
  supportsReconcile:boolean;enforcesOutputTokenLimit:boolean;
 }>;
 quote(request:AnalysisRequest):Promise<AnalysisQuote>;
 reconcile(request:AnalysisRequest):Promise<{state:'completed';result:unknown}|{state:'pending'|'not_found'|'unknown'}>;
 analyze(request:AnalysisRequest):Promise<unknown>;
}
/** Atomic, durable owner-bound reservation is mandatory; an existing admission never authorizes another call. */
export interface DurableAnalysisRequestGate {
 admit(request:{ownerId:string;requestId:string;snapshotHash:string;policyHash:string;reservedCostDollars:number}):Promise<'admitted'|'existing'|'blocked'>;
 persist(ownerId:string,analysis:ReviewAnalysis):Promise<void>;
}
