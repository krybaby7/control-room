import type {CoverageSnapshot,SourceCapability} from './contracts.ts';
export interface FreshnessInput {
 now:string;maxLagMs:number;allowedClockSkewMs:number;running:boolean;offline:boolean;
 failure:{phase:'inventory'|'content';at:string;kind:string}|null;
 heartbeatAt:string|null;lastAttemptAt:string|null;nextDueAt:string|null;oldestPendingAt:string|null;continuation:string|null;
}
/** Heartbeat and HTTP success are diagnostics only. A phase failure clears only
 * when that phase has a strictly later successful sweep. */
export function historyFreshness(coverage:CoverageSnapshot,capability:SourceCapability,input:FreshnessInput):CoverageSnapshot['status'] {
 const now=Date.parse(input.now);
 if(!Number.isFinite(now)||!Number.isFinite(input.maxLagMs)||input.maxLagMs<=0||!Number.isFinite(input.allowedClockSkewMs)||input.allowedClockSkewMs<0)throw Error('Invalid freshness policy');
 if(input.failure){if(!Number.isFinite(Date.parse(input.failure.at)))throw Error('Invalid failure clock');const success=input.failure.phase==='inventory'?coverage.lastInventorySuccessAt:coverage.lastContentSuccessAt;if(!success||Date.parse(success)<=Date.parse(input.failure.at))return 'error';}
 const times=[coverage.lastInventorySuccessAt,coverage.lastContentSuccessAt];
 if(input.oldestPendingAt!==null&&(!Number.isFinite(Date.parse(input.oldestPendingAt))||now-Date.parse(input.oldestPendingAt)>input.maxLagMs||Date.parse(input.oldestPendingAt)>now+input.allowedClockSkewMs))return 'stale';
 if(input.offline||times.some(time=>time!==null&&(!Number.isFinite(Date.parse(time))||Date.parse(time)>now+input.allowedClockSkewMs||now-Date.parse(time)>input.maxLagMs)))return 'stale';
 if(coverage.unresolvedGaps>0||coverage.partial>0||coverage.unavailable>0||capability.inventory==='partial'||capability.contentRead==='partial'||capability.inventory==='unsupported'||capability.contentRead==='unsupported')return 'partial';
 if(input.running||input.continuation!==null||input.oldestPendingAt!==null)return 'syncing';
 if(capability.inventory==='verified'&&capability.contentRead==='verified'&&coverage.inventoryComplete&&coverage.contentComplete&&times.every(time=>time!==null))return 'current';
 return coverage.discovered>0?'partial':'unverified';
}
