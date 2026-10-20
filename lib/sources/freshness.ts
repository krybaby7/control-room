import {z} from 'zod';
import type {AdapterCapabilities,SourceConnection,SourceTarget,SourceSyncState,SourceRunHistory,SourceState} from './contracts.ts';
import {sourceConnectionSchema,sourceTargetSchema,sourceRunHistorySchema,sourceFailureSchema,sourceKindSchema} from './validation.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
const stamp=evidenceDateSchema;
const stateSchema=z.object({sourceId:z.string().min(1).max(128),operationalRevision:z.number().int().positive().safe(),configurationHash:z.string().regex(/^[a-f0-9]{64}$/),executionEpoch:z.number().int().nonnegative().safe(),paused:z.boolean(),cursor:z.string().max(16000).nullable(),etag:z.string().max(2000).nullable(),attemptedAt:stamp.nullable(),lastSuccessAt:stamp.nullable(),lastSourceRevision:z.string().max(512).nullable(),failure:sourceFailureSchema.nullable(),retryAt:stamp.nullable(),failureCount:z.number().int().nonnegative().safe()}).strict();
const capsSchema=z.object({sourceKinds:z.array(sourceKindSchema).max(4),interactiveRead:z.boolean(),unattendedRead:z.boolean(),verifiedAt:stamp.nullable(),blockedReason:z.string().max(8000).nullable()}).strict();
/** Success metadata changes only after an entire successful/unchanged read, never after a partial page. */
export function applySourceRun(previous:SourceSyncState,value:SourceRunHistory):SourceSyncState{
 const state=stateSchema.parse(previous),run=sourceRunHistorySchema.parse(value);
 if(run.sourceId!==state.sourceId||Date.parse(run.finishedAt)<Date.parse(run.startedAt)||state.attemptedAt&&Date.parse(run.startedAt)<Date.parse(state.attemptedAt)||state.lastSuccessAt&&Date.parse(run.finishedAt)<Date.parse(state.lastSuccessAt))throw new Error('Source attempt does not match the current source clock.');
 const success=run.outcome==='success'||run.outcome==='unchanged';if(success&&run.failure)throw new Error('A failed attempt cannot record a success.');
 return stateSchema.parse({...state,attemptedAt:run.startedAt,lastSuccessAt:success?run.finishedAt:state.lastSuccessAt,lastSourceRevision:success?run.sourceRevision??state.lastSourceRevision:state.lastSourceRevision,failure:run.failure,retryAt:success?null:run.retryAt,failureCount:success?0:state.failureCount+1});
}
export interface SourceFreshness {state:SourceState;partial:boolean;stale:boolean;lastSuccessAt:string|null;lastSourceRevision:string|null;ageSeconds:number|null;reason:'paused'|'disconnected'|'capability_unverified'|'unsupported'|'syncing'|'partial'|'failed'|'never_succeeded'|'expired'|'fresh'|'clock_mismatch'}
export function sourceFreshness(input:{connection:SourceConnection|null;target:SourceTarget;state:SourceSyncState|null;capabilities:AdapterCapabilities|null;lastRun?:SourceRunHistory|null;now:string;syncing?:boolean}):SourceFreshness{
 const target=sourceTargetSchema.parse(input.target),connection=input.connection===null?null:sourceConnectionSchema.parse(input.connection),state=input.state===null?null:stateSchema.parse(input.state),caps=input.capabilities===null?null:capsSchema.parse(input.capabilities),now=Date.parse(stamp.parse(input.now)),run=input.lastRun?sourceRunHistorySchema.parse(input.lastRun):null;
 if(connection&&target.connectionId!==connection.id||state&&state.sourceId!==target.id||run&&run.sourceId!==target.id)throw new Error('Freshness requires one exact selected source.');
 const age=state?.lastSuccessAt?Math.floor((now-Date.parse(state.lastSuccessAt))/1000):null,partial=!!run&&!!state?.attemptedAt&&Date.parse(run.startedAt)===Date.parse(state.attemptedAt)&&run.outcome==='partial';
 const result=(status:SourceState,reason:SourceFreshness['reason']):SourceFreshness=>({state:status,reason,partial,stale:reason!=='fresh',lastSuccessAt:state?.lastSuccessAt??null,lastSourceRevision:state?.lastSourceRevision??null,ageSeconds:age===null?null:Math.max(0,age)});
 if(target.archivedAt||connection?.archivedAt||connection&&!connection.enabled||state?.paused)return result('paused','paused');
 if(!connection)return result('disconnected','disconnected');
 if(caps&&!caps.sourceKinds.includes(target.kind))return result('unsupported','unsupported');
 if(!caps||!caps.verifiedAt||Date.parse(caps.verifiedAt)>now||caps.blockedReason!==null||!(connection.accessMode==='interactive'?caps.interactiveRead:caps.unattendedRead))return result('needs_connection','capability_unverified');
 if(state?.failure==='unsupported')return result('unsupported','unsupported');
 if(state?.failure&&['binding_unavailable','connector_access_disabled','revoked'].includes(state.failure))return result('disconnected','disconnected');
 if(state?.failure&&['request_context_expired','reauthentication_required'].includes(state.failure))return result('needs_connection','capability_unverified');
 if(age!==null&&age<0||state?.attemptedAt&&Date.parse(state.attemptedAt)>now)return result('stale','clock_mismatch');
 if(input.syncing)return result('syncing','syncing');
 if(partial)return result(state?.lastSuccessAt?'stale':'failed','partial');
 if(state&&(state.failure||state.failureCount>0))return result(state.lastSuccessAt?'stale':'failed','failed');
 if(age===null)return result('stale','never_succeeded');
 if(age>=target.staleAfterSeconds)return result('stale','expired');
 return result('fresh','fresh');
}
