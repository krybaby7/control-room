import {receiptCount} from './workspace-capacity.ts';
import {readCurrent,type SqlDatabase,type SqlStatement} from './workspace-store.ts';
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
 const fixedScope=Object.freeze({...scope});
 if(!owner||!Number.isFinite(Date.parse(fixedScope.now))||!Number.isSafeInteger(fixedScope.expectedRevision)||fixedScope.expectedRevision<1||!fixedScope.mutationId)throw new Error('Invalid planning capture scope.');
 mutationEpoch(fixedScope.mutationId);
 const before=await readCurrent(db,owner,fixedScope.now);
 const token=Object.freeze({}) as PlanningCapture;
 captures.set(token,{db,owner,scope:fixedScope,envelope:structuredClone(before)});
 return {before,capture:Object.freeze({...fixedScope,token})};
}
/** Consumes only an opaque, DB/owner/mutation(epoch)/revision/time-bound capture.
 * JSON, foreign DB/owner, changed scope and a second use fail closed. */
export function consumePlanningCapture(db:SqlDatabase,owner:string,now:string,capture:ScopedPlanningCapture):Envelope{
 const entry=capture&&typeof capture==='object'&&capture.token&&typeof capture.token==='object'?captures.get(capture.token):undefined;
 if(!entry||entry.db!==db||entry.owner!==owner||entry.scope.now!==now||capture.now!==now||entry.scope.mutationId!==capture.mutationId||entry.scope.expectedRevision!==capture.expectedRevision||entry.envelope.revision!==capture.expectedRevision)throw new Error('Invalid or consumed planning capture.');
 captures.delete(capture.token);
 return structuredClone(entry.envelope);
}

/** The initial planning SELECT and receipt COUNT are independent read preflights.
 * They share one closed read-only batch. Baseline deletion hydration stays a
 * subsequent dependent read. Receipt failure is observed explicitly AFTER the
 * caller's original before.revision conflict check, preserving error priority. */
export async function capturePlanningPreflight(db:SqlDatabase,owner:string,scope:PlanningCaptureScope):Promise<{before:Envelope;capture:ScopedPlanningCapture;readReceiptCount:()=>number}>{
 const fixedScope=Object.freeze({...scope});
 if(!owner||!Number.isFinite(Date.parse(fixedScope.now))||!Number.isSafeInteger(fixedScope.expectedRevision)||fixedScope.expectedRevision<1||!fixedScope.mutationId)throw new Error('Invalid planning capture scope.');
 mutationEpoch(fixedScope.mutationId);
 type Pending={statement:SqlStatement;maximumRows:number;resolve:(rows:unknown[])=>void;reject:(error:unknown)=>void};
 const pending:Pending[]=[];let scheduled=false,inFlight=false,requests=0;
 function schedule(){if(scheduled||inFlight||!pending.length)return;scheduled=true;void Promise.resolve().then(flush);}
 async function flush(){
 scheduled=false;if(inFlight||!pending.length)return;inFlight=true;const entries=pending.splice(0);
 try{
 const result=await db.batch(entries.map(entry=>entry.statement));
 if(!Array.isArray(result)||result.length!==entries.length)throw new Error('Invalid planning preflight batch.');
 for(const [index,entry]of entries.entries()){const rows=result[index]?.results;if(!Array.isArray(rows)||rows.length>entry.maximumRows||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('Invalid planning preflight rows.');}
 for(const [index,entry]of entries.entries())entry.resolve(result[index].results!);
 }catch(error){for(const entry of entries)entry.reject(error);for(const entry of pending.splice(0))entry.reject(error);}
 finally{inFlight=false;schedule();}
 }
 const reader:SqlDatabase={prepare(sql){
 const planning=sql.startsWith('SELECT w.content,w.revision,w.updated_at,'),baseline=sql.startsWith('SELECT DISTINCT entity_id FROM audit_events '),count=sql==='SELECT COUNT(*) AS count FROM workspace_mutations WHERE user_id=?';
 if(sql.includes(';')||!planning&&!baseline&&!count)throw new Error('Unexpected planning preflight query.');
 let native=db.prepare(sql),started=false,maximumRows=1;
 const statement:SqlStatement={bind(...values){if(started)throw new Error('Planning preflight bind followed a read.');if(baseline){let ids:unknown;try{ids=JSON.parse(String(values[1]));}catch{throw new Error('Invalid planning preflight candidates.');}if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw new Error('Invalid planning preflight candidates.');maximumRows=ids.length;}native=native.bind(...values);return statement;},
 async first<T>(){const rows=await read();return (rows[0]??null)as T|null;},
 async all<T>(){return {results:await read()as T[]};},
 async run(){throw new Error('Planning preflight cannot mutate.');}};
 function read():Promise<unknown[]>{if(started||++requests>3)return Promise.reject(new Error('Planning preflight read bound exceeded.'));started=true;return new Promise((resolve,reject)=>{pending.push({statement:native,maximumRows,resolve,reject});schedule();});}
 return statement;
 },async batch(){throw new Error('Planning preflight cannot issue nested batches.');}};
 const [planning,count]=await Promise.allSettled([readCurrent(reader,owner,fixedScope.now),receiptCount(reader,owner)]);
 if(planning.status==='rejected')throw planning.reason;
 const before=planning.value,token=Object.freeze({})as PlanningCapture;
 captures.set(token,{db,owner,scope:fixedScope,envelope:structuredClone(before)});
 return {before,capture:Object.freeze({...fixedScope,token}),readReceiptCount(){if(count.status==='rejected')throw count.reason;return count.value;}};
}
