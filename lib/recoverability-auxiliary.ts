import {consumePlanningCapture,type ScopedPlanningCapture} from './recoverability-planning-capture.ts';
import {readCurrent,type SqlDatabase,type SqlStatement} from './workspace-store.ts';
import {readOperationalWatermarks} from './operational-watermarks.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
type ReserveRow={job_id:string;operational_revision:number;status:string;approval_id:string};
export interface RecoverabilityAuxiliary {
 current:Awaited<ReturnType<typeof readCurrent>>;
 namespaces:Awaited<ReturnType<typeof getWorkspaceNamespaces>>;
 watermarks:Record<string,number>;
 terminalReserveRows:ReserveRow[];
}
/** These existing owner readers retain their exact SQL and decoders. Only their
 * independent SELECTs share a local read-only batch; dependent weekly/baseline
 * reads join a subsequent batch. Nothing is retained between calls or owners. */
export async function readRecoverabilityAuxiliary(db:SqlDatabase,owner:string,now:string,options:{includeTerminalReserve?:boolean;includeNamespaces?:boolean;planningCapture?:ScopedPlanningCapture}={}):Promise<RecoverabilityAuxiliary>{
 if(!owner||!Number.isFinite(Date.parse(now)))throw new Error('An owner and valid snapshot timestamp are required.');
 type Pending={statement:SqlStatement;maximumRows:number;resolve:(rows:unknown[])=>void;reject:(error:unknown)=>void};
 const pending:Pending[]=[];let requested=0,scheduled=false,inFlight=false,failed:unknown;
 function schedule(){if(scheduled||inFlight||!pending.length)return;scheduled=true;void Promise.resolve().then(flush);}
 async function flush(){
  scheduled=false;if(inFlight||!pending.length)return;inFlight=true;const batch=pending.splice(0);
  try{
   const results=await db.batch(batch.map(entry=>entry.statement));
   if(!Array.isArray(results)||results.length!==batch.length)throw new Error('Invalid auxiliary snapshot batch.');
   for(const [index,entry]of batch.entries()){const rows=results[index]?.results;if(!Array.isArray(rows)||rows.length>entry.maximumRows||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('Invalid auxiliary snapshot batch rows.');}
   for(const [index,entry]of batch.entries())entry.resolve(results[index].results!);
  }catch(error){failed=error;for(const entry of batch)entry.reject(error);for(const entry of pending.splice(0))entry.reject(error);}
  finally{inFlight=false;schedule();}
 }
 function read(statement:SqlStatement,maximumRows:number):Promise<unknown[]>{
  if(failed!==undefined)return Promise.reject(failed);
  if(++requested>8)return Promise.reject(new Error('Auxiliary snapshot read contract exceeded its closed query bound.'));
  return new Promise((resolve,reject)=>{pending.push({statement,maximumRows,resolve,reject});schedule();});
 }
 const reader:SqlDatabase={
  prepare(sql){
   const known=['SELECT w.content,w.revision,w.updated_at,','SELECT audit_namespace,blob_namespace,cursor_secret FROM workspace_source_namespaces ','SELECT DISTINCT entity_id FROM audit_events ','SELECT job_id,operational_revision,status,approval_id FROM agent_job_state ','WITH watermark_owner AS MATERIALIZED(SELECT ? user_id),selected_heads AS MATERIALIZED(SELECT stream_id,last_sequence FROM operational_stream_heads '];
   if(sql.includes(';')||!known.some(prefix=>sql.startsWith(prefix)))throw new Error('Unexpected auxiliary snapshot read query.');
   let native=db.prepare(sql),readStarted=false,maximumRows=sql.startsWith('SELECT job_id,')?13:1;
   const dependent=sql.startsWith('SELECT DISTINCT entity_id FROM audit_events ');
   const statement:SqlStatement={bind(...values){if(readStarted)throw new Error('Auxiliary snapshot bind followed a read.');if(dependent){let ids:unknown;try{ids=JSON.parse(String(values[1]));}catch{throw new Error('Invalid auxiliary candidate binding.');}if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw new Error('Invalid auxiliary candidate binding.');maximumRows=ids.length;}
    native=native.bind(...values);return statement;},async first<T>(){if(readStarted)throw new Error('Auxiliary snapshot statement reused.');readStarted=true;const rows=await read(native,1);return (rows[0]??null)as T|null;},async all<T>(){if(readStarted)throw new Error('Auxiliary snapshot statement reused.');readStarted=true;return {results:await read(native,maximumRows)as T[]};},async run(){throw new Error('Auxiliary snapshot cannot mutate.');}};
   return statement;
  },
  async batch(){throw new Error('Auxiliary readers cannot issue nested batches.');},
 };
 const reserve=options.includeTerminalReserve?reader.prepare("SELECT job_id,operational_revision,status,approval_id FROM agent_job_state WHERE user_id=? AND approval_id IS NOT NULL AND status IN ('queued','leased','running','cancelling','reconcile_required') ORDER BY job_id LIMIT 13").bind(owner).all<ReserveRow>().then(value=>value.results):Promise.resolve<ReserveRow[]>([]);
 const [current,namespaces,watermarks,terminalReserveRows]=await Promise.all([options.planningCapture?Promise.resolve(consumePlanningCapture(db,owner,now,options.planningCapture)):readCurrent(reader,owner,now),options.includeNamespaces===false?Promise.resolve(null):getWorkspaceNamespaces(reader,owner),readOperationalWatermarks(reader,owner),reserve]);
 return {current,namespaces,watermarks,terminalReserveRows};
}
