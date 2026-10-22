import type {SqlDatabase} from '../workspace-store.ts';
import {enqueueHistorySync,type HistoryRunnerAuthority,type HistorySyncClaim} from './job-store.ts';
/** Existing queue only. Caller supplies a finite due occurrence and a freshly
 * revalidated service principal; saving a schedule never creates access proof. */
export async function scheduleHistoryOccurrence(db:SqlDatabase,input:{ownerId:string;sourceId:string;kind:HistorySyncClaim['kind'];dueAt:string;now:string;authority?:HistoryRunnerAuthority}):Promise<{status:'queued';intentId:string}|{status:'unavailable'}>{const intentId=await enqueueHistorySync(db,input);return intentId?{status:'queued',intentId}:{status:'unavailable'};}
