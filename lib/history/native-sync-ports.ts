import type {SqlDatabase} from '../workspace-store.ts';
import type {PrivateHistoryBucket} from './object-store.ts';
import type {HistoryRunnerAuthority,HistorySyncClaim} from './job-store.ts';
import type {HistorySyncRunnerPorts} from './sync-runner.ts';
import {createPendingEnvelopeObjectPort} from './pending-envelope-objects.ts';
/** Server composition only. A registered read-only adapter supplies acquisition;
 * pending bytes always use the native owner quota, immutable ledger and lease. */
export function nativeHistorySyncPorts(input:{db:SqlDatabase;bucket:PrivateHistoryBucket;authority:HistoryRunnerAuthority;claim:HistorySyncClaim;now:()=>string;reader:Pick<HistorySyncRunnerPorts,'read'|'verify'|'contentProgress'>}):Omit<HistorySyncRunnerPorts,'commitPageAtomic'>{
 return {objects:createPendingEnvelopeObjectPort(input),read:input.reader.read,verify:input.reader.verify,...(input.reader.contentProgress?{contentProgress:input.reader.contentProgress}:{})};
}
