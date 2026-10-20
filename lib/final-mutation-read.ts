import {readMutationAdmission} from './mutation-admission-reader.ts';
import {readCurrent,type SqlDatabase,type SqlStatement} from './workspace-store.ts';
/** Read the final admission and current workspace in one closed read-only batch.
 * Hydration keeps its original dependent baseline query. Both outcomes are
 * drained; callers observe admission/receipt/hash errors before workspace errors.
 * This snapshot is not execution authority; atomic write guards stay unchanged. */
export async function readFinalMutation(db:SqlDatabase,owner:string,mutationId:string,now:string){
 type Pending={statement:SqlStatement;maximumRows:number;resolve:(rows:unknown[])=>void;reject:(error:unknown)=>void};
 const pending:Pending[]=[];let scheduled=false,inFlight=false,requests=0;
 function schedule(){if(scheduled||inFlight||!pending.length)return;scheduled=true;void Promise.resolve().then(flush);}
 async function flush(){
  scheduled=false;if(inFlight||!pending.length)return;inFlight=true;const entries=pending.splice(0);
  try{
   const result=await db.batch(entries.map(entry=>entry.statement));
   if(!Array.isArray(result)||result.length!==entries.length)throw new Error('Invalid final mutation batch.');
   for(const [index,entry]of entries.entries()){const rows=result[index]?.results;if(!Array.isArray(rows)||rows.length>entry.maximumRows||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('Invalid final mutation rows.');}
   for(const [index,entry]of entries.entries())entry.resolve(result[index].results!);
  }catch(error){for(const entry of entries)entry.reject(error);for(const entry of pending.splice(0))entry.reject(error);}
  finally{inFlight=false;schedule();}
 }
 const reader:SqlDatabase={prepare(sql){
  const admission=sql.startsWith('SELECT e.status epoch_status,m.mutation_id receipt_id,'),planning=sql.startsWith('SELECT w.content,w.revision,w.updated_at,'),baseline=sql.startsWith('SELECT DISTINCT entity_id FROM audit_events ');
  if(sql.includes(';')||!admission&&!planning&&!baseline)throw new Error('Unexpected final mutation query.');
  let native=db.prepare(sql),started=false,maximumRows=1;
  const statement:SqlStatement={bind(...values){if(started)throw new Error('Final mutation bind followed a read.');if(baseline){let ids:unknown;try{ids=JSON.parse(String(values[1]));}catch{throw new Error('Invalid final mutation candidates.');}if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw new Error('Invalid final mutation candidates.');maximumRows=ids.length;}native=native.bind(...values);return statement;},
   async first<T>(){const rows=await read();return (rows[0]??null)as T|null;},async all<T>(){return {results:await read()as T[]};},async run(){throw new Error('Final mutation cannot mutate.');}};
  function read():Promise<unknown[]>{if(started||++requests>3)return Promise.reject(new Error('Final mutation read bound exceeded.'));started=true;return new Promise((resolve,reject)=>{pending.push({statement:native,maximumRows,resolve,reject});schedule();});}
  return statement;
 },async batch(){throw new Error('Final mutation cannot issue nested batches.');}};
 const [admission,current]=await Promise.allSettled([readMutationAdmission(reader,owner,mutationId),readCurrent(reader,owner,now)]);
 if(admission.status==='rejected')throw admission.reason;
 return {admission:admission.value,readCurrent(){if(current.status==='rejected')throw current.reason;return current.value;}};
}
