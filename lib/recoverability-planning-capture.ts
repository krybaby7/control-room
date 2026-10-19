import {readCurrent,type SqlDatabase} from './workspace-store.ts';
import {mutationEpoch} from './idempotency-retention.ts';
type Envelope=Awaited<ReturnType<typeof readCurrent>>;
export interface PlanningCaptureScope {readonly mutationId:string;readonly expectedRevision:number;readonly now:string}
declare const planningCaptureBrand:unique symbol;
export interface PlanningCapture {readonly [planningCaptureBrand]:true}
export interface ScopedPlanningCapture extends PlanningCaptureScope {readonly token:PlanningCapture}
const captures=new WeakMap<object,{db:SqlDatabase;owner:string;scope:PlanningCaptureScope;envelope:Envelope}>();
/** A single operation's actual owner read, never an authorization or a cache.
 * Return a separate planning copy so handler mutations cannot change the captured
 * bytes. The compiler must retain its final reread and atomic epoch/row guards. */
export async function capturePlanningForRecoverability(db:SqlDatabase,owner:string,scope:PlanningCaptureScope):Promise<{before:Envelope;capture:ScopedPlanningCapture}>{
 if(!owner||!Number.isFinite(Date.parse(scope.now))||!Number.isSafeInteger(scope.expectedRevision)||scope.expectedRevision<1||!scope.mutationId)throw new Error('Invalid planning capture scope.');
 mutationEpoch(scope.mutationId);
 const before=await readCurrent(db,owner,scope.now);
 const token=Object.freeze({}) as PlanningCapture;
 captures.set(token,{db,owner,scope:{...scope},envelope:structuredClone(before)});
 return {before,capture:Object.freeze({...scope,token})};
}
/** Consumes only an opaque, DB/owner/mutation(epoch)/revision/time-bound capture.
 * JSON, foreign DB/owner, changed scope and a second use fail closed. */
export function consumePlanningCapture(db:SqlDatabase,owner:string,now:string,capture:ScopedPlanningCapture):Envelope{
 const entry=capture&&typeof capture==='object'&&capture.token&&typeof capture.token==='object'?captures.get(capture.token):undefined;
 if(!entry||entry.db!==db||entry.owner!==owner||entry.scope.now!==now||capture.now!==now||entry.scope.mutationId!==capture.mutationId||entry.scope.expectedRevision!==capture.expectedRevision||entry.envelope.revision!==capture.expectedRevision)throw new Error('Invalid or consumed planning capture.');
 captures.delete(capture.token);
 return structuredClone(entry.envelope);
}
