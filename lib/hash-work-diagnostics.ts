/** Profiling-only observer: fixed labels and byte counts, never inputs/digests.
 * No observer => no clocks or retained work. No production authority or cache. */
export const HASH_WORK_STAGES=['canonical','row-json-parse','composite-schema','planning-schema','sha-encode','sha-submit','sha-await','sha-hex']as const;
export type HashWorkStage=typeof HASH_WORK_STAGES[number];
export type HashWorkListener=(stage:HashWorkStage)=>((bytes:number)=>void)|void;
let registration:{listener:HashWorkListener}|undefined;
const noop=(_bytes=0)=>{};
export function registerHashWorkDiagnostics(listener:HashWorkListener):()=>void{const current={listener};registration=current;return()=>{if(registration===current)registration=undefined;};}
export function startHashWork(stage:HashWorkStage):(bytes?:number)=>void{
 if(!registration||!HASH_WORK_STAGES.includes(stage))return noop;
 let finish:ReturnType<HashWorkListener>;try{finish=registration.listener(stage);}catch{return noop;}
 if(typeof finish!=='function')return noop;
 const callback=finish;let ended=false;return(bytes=0)=>{if(ended)return;ended=true;try{callback(Number.isSafeInteger(bytes)&&bytes>=0?bytes:0);}catch{/* Diagnostics cannot change hashing/validation. */}};
}
