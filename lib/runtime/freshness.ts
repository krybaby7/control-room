import {evidenceDateSchema} from '../evidence-validation.ts';
import {RUNTIME_LIMITS,type RuntimeObservationV1,type HeartbeatReceipt,type RuntimeFreshnessResult} from './contracts.ts';
import {runtimeObservationSchema,heartbeatReceiptSchema} from './validation.ts';
export interface RuntimeFreshnessInput {now:string;lastLiveReceivedAt:string|null;revoked:boolean;observation:RuntimeObservationV1|null;receipt:HeartbeatReceipt|null}
/** Use original server receive/window clocks; never synthesize a source timestamp. */
export function runtimeFreshness(input:RuntimeFreshnessInput):RuntimeFreshnessResult{
 const now=Date.parse(evidenceDateSchema.parse(input.now)),last=input.lastLiveReceivedAt===null?null:Date.parse(evidenceDateSchema.parse(input.lastLiveReceivedAt));
 const observation=input.observation===null?null:runtimeObservationSchema.parse(input.observation),receipt=input.receipt===null?null:heartbeatReceiptSchema.parse(input.receipt);
 const heartbeatAge=last===null||last>now?null:(now-last)/1000,received=receipt===null?null:Date.parse(receipt.receivedAt),serverAge=received===null||received>now?null:(now-received)/1000;
 const connectivity=input.revoked?'revoked':heartbeatAge===null?'never-seen':heartbeatAge<=RUNTIME_LIMITS.onlineSeconds?'online':heartbeatAge<=RUNTIME_LIMITS.offlineSeconds?'stale':'offline';
 const age=observation?.reportedAgeSeconds??null,transport=receipt?.classification==='live'?receipt.transportAgeUpperBoundSeconds:null,ingest=age===null||transport===null?null:age+transport,effective=ingest===null||serverAge===null?null:ingest+serverAge;
 const result:RuntimeFreshnessResult={connectivity,source:'unknown',heartbeatAgeSeconds:heartbeatAge,serverAgeSeconds:serverAge,reportedAgeSeconds:age,effectiveSampleAgeUpperBoundSeconds:effective};
 if(!observation)return result;
 if(observation.state==='disabled'){result.source='disabled';return result;}
 if(observation.state==='unavailable'){result.source='unavailable';return result;}
 const sample=observation.observedAt===null?null:Date.parse(observation.observedAt);
 const skew=received!==null&&sample!==null&&Math.abs((received-sample)/1000-(age??0)-(transport??0))>RUNTIME_LIMITS.clockSkewSeconds;
 if(skew||received!==null&&received>now||last!==null&&last>now){result.source='clock-skew';return result;}
 if(receipt===null)return result;
 if(receipt.classification!=='live'){result.source='stale';return result;}
 if(effective===null)return result;
 result.source=connectivity==='online'&&observation.state==='ready'&&observation.diagnostic==='ok'&&ingest!<=RUNTIME_LIMITS.ingestFreshSeconds&&effective<=RUNTIME_LIMITS.freshSeconds?'fresh':'stale';return result;
}
