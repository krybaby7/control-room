import {createSubscriptionRuntime} from './runtime.mjs';
/** Production entry point. The pinned runtime registry is empty, so no lease,
 * worktree, process, command, provider fallback or model call is performed. */
export function createLocalExecutor(){
 const runtime=createSubscriptionRuntime();
 return Object.freeze({enabled:false,async probeLocalExecution(){return runtime.probeLocalExecution();},async execute(){return {status:'blocked',diagnostic:'not_installed',processStarted:false,processExitConfirmed:false,modelVerified:false};}});
}
