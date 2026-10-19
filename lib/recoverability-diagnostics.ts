import type {SqlDatabase} from './workspace-store.ts';
export const RECOVERABILITY_PHASES=['hash-current','originalserializer','bundleoriginal','projectplan','afterserializer','bundleafter','expandfuture','measure','finalreads'] as const;
export type RecoverabilityPhase=typeof RECOVERABILITY_PHASES[number];
/** Observer installation is DB-bound routing, not stored owner/request state.
 * A listener captures its current request-local diagnostic sink at phase START;
 * its returned callback receives only elapsed time at phase END. */
export type RecoverabilityDiagnosticsListener=(phase:RecoverabilityPhase)=>((elapsedMilliseconds:number)=>void)|void;
const observers=new WeakMap<SqlDatabase,{listener:RecoverabilityDiagnosticsListener}>();
const noop=()=>{};
export function registerRecoverabilityDiagnostics(db:SqlDatabase,listener:RecoverabilityDiagnosticsListener):()=>void{
 const registration={listener};observers.set(db,registration);
 return ()=>{if(observers.get(db)===registration)observers.delete(db);};
}
function clock():number{return typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now();}
/** No observer => no timer and no retained phase. Observers are trusted server
 * instrumentation only; errors must never change command/admission behavior.
 * Completion is idempotent, and captures the START listener's request sink. */
export function startRecoverabilityPhase(db:SqlDatabase,phase:RecoverabilityPhase):()=>void{
 const observer=observers.get(db)?.listener;if(!observer)return noop;
 if(!RECOVERABILITY_PHASES.includes(phase))return noop;
 let complete:ReturnType<RecoverabilityDiagnosticsListener>;
 try{complete=observer(phase);}catch{return noop;}
 if(typeof complete!=='function')return noop;
 const callback=complete,started=clock();let ended=false;
 return ()=>{if(ended)return;ended=true;try{const elapsed=clock()-started;callback(Number.isFinite(elapsed)?Math.max(0,elapsed):0);}catch{/* Diagnostic failures cannot change owner data or admission. */}};
}
