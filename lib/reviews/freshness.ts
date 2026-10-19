import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {sourceObservationRefSchema,sourceObservationSchema,sourceTargetSchema,sourceFailureSchema} from '../sources/validation.ts';
import type {SourceObservation,SourceObservationRef,SourceSyncState,SourceTarget} from '../sources/contracts.ts';
import {REVIEW_LIMITS} from './contracts.ts';
const stateSchema=z.object({sourceId:z.string().min(1).max(128),operationalRevision:z.number().int().positive().safe(),configurationHash:z.string().regex(/^[a-f0-9]{64}$/),executionEpoch:z.number().int().nonnegative().safe(),paused:z.boolean(),cursor:z.string().max(16000).nullable(),etag:z.string().max(2000).nullable(),attemptedAt:evidenceDateSchema.nullable(),lastSuccessAt:evidenceDateSchema.nullable(),lastSourceRevision:z.string().max(512).nullable(),failure:sourceFailureSchema.nullable(),retryAt:evidenceDateSchema.nullable(),failureCount:z.number().int().nonnegative().safe()}).strict();
export interface ReviewSourceFreshness {
 sourceId:string;stale:boolean;reason:'archived'|'paused'|'failed'|'never_succeeded'|'clock_mismatch'|'expired'|'fresh';
 lastSuccessAt:string|null;attemptedAt:string|null;retryAt:string|null;failure:SourceSyncState['failure'];ageSeconds:number|null;
 observedAt:string|null;sourceUpdatedAt:string|null;
}
/** This evaluates recorded freshness, not provider capability or scientific validity.
 * An observation/import date never substitutes for an unknown source update date. */
export function reviewSourceFreshness(input:{target:SourceTarget;state:SourceSyncState|null;observations:readonly SourceObservation[];now:string}):ReviewSourceFreshness {
 if(input.observations.length>REVIEW_LIMITS.assemblyRows)throw new Error('Freshness observation input exceeds its bound.');
 const target=sourceTargetSchema.parse(input.target),now=Date.parse(evidenceDateSchema.parse(input.now)),state=input.state===null?null:stateSchema.parse(input.state);
 if(state&&state.sourceId!==target.id)throw new Error('Freshness requires the exact source state.');
 for(const value of [state?.lastSuccessAt,state?.attemptedAt,state?.retryAt])if(value!==null&&value!==undefined)evidenceDateSchema.parse(value);
 const observations=input.observations.map(value=>sourceObservationSchema.parse(value));
 if(observations.some(value=>value.sourceId!==target.id))throw new Error('Freshness observations belong to another source.');
 const latest=observations.toSorted((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||(a.id<b.id?-1:a.id>b.id?1:0))[0];
 const age=state?.lastSuccessAt?(now-Date.parse(state.lastSuccessAt))/1000:null;
 const reason:ReviewSourceFreshness['reason']=target.archivedAt?'archived':state?.paused?'paused':age!==null&&age<0||state?.attemptedAt&&Date.parse(state.attemptedAt)>now||latest&&(Date.parse(latest.observedAt)>now||latest.sourceUpdatedAt!==null&&Date.parse(latest.sourceUpdatedAt)>now)?'clock_mismatch':state?.failure||state&&state.failureCount>0?'failed':age===null?'never_succeeded':age>=target.staleAfterSeconds?'expired':'fresh';
 return {sourceId:target.id,stale:reason!=='fresh',reason,lastSuccessAt:state?.lastSuccessAt??null,attemptedAt:state?.attemptedAt??null,retryAt:state?.retryAt??null,failure:state?.failure??null,ageSeconds:age===null?null:Math.max(0,Math.floor(age)),observedAt:latest?.observedAt??null,sourceUpdatedAt:latest?.sourceUpdatedAt??null};
}
/** Hash the exact used immutable observation set, independent of arrival order. */
export async function reviewSourceWatermark(input:readonly SourceObservationRef[]):Promise<string>{
 if(input.length>REVIEW_LIMITS.assemblyRows)throw new Error('Source watermark input exceeds its bound.');
 const refs=input.map(value=>sourceObservationRefSchema.parse(value)),seen=new Map<string,string>();
 for(const ref of refs){const previous=seen.get(ref.id);if(previous&&previous!==ref.contentDigest)throw new Error('One source observation has conflicting digests.');seen.set(ref.id,ref.contentDigest);}
 return contentHash(canonical([...seen].sort(([a],[b])=>(a<b?-1:a>b?1:0)).map(([id,contentDigest])=>({id,contentDigest}))));
}
