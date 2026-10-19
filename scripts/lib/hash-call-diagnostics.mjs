// Node benchmark instrumentation only. No production imports or digest memoization.
export const HASH_DIAGNOSTIC_LIMITS=Object.freeze({uniqueInputs:4096,retainedUtf8Bytes:1024*1024,inputBytes:256*1024});
const phases=new Set(['hash-current','originalserializer','bundleoriginal','projectplan','afterserializer','bundleafter','expandfuture','measure','finalreads','outside-recovery']);
const states=new WeakMap(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
export function createHashCallFrame(){
 const state={nativeDigestCalls:0,sha256Calls:0,trackedCalls:0,duplicateCalls:0,uniqueInputs:0,inputBytes:0,duplicateInputBytes:0,retainedUtf8Bytes:0,untrackedCalls:0,invalidUtf8Calls:0,diagnosticFailures:0,byPhase:{}};
 states.set(state,{inputs:new Set(),closed:false});return state;
}
function bytesOf(value){
 if(value instanceof ArrayBuffer)return new Uint8Array(value);
 if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
 return null;
}
function record(state,phase,algorithm,data){
 const privateState=states.get(state);if(!privateState||privateState.closed)return;
 state.nativeDigestCalls++;
 const name=typeof algorithm==='string'?algorithm:algorithm?.name;
 if(typeof name!=='string'||name.toUpperCase()!=='SHA-256')return;
 state.sha256Calls++;
 const label=phases.has(phase)?phase:'outside-recovery',group=state.byPhase[label]??={calls:0,trackedCalls:0,duplicateCalls:0,inputBytes:0,duplicateInputBytes:0};group.calls++;
 const bytes=bytesOf(data);if(!bytes){state.untrackedCalls++;return;}
 state.inputBytes+=bytes.byteLength;group.inputBytes+=bytes.byteLength;
 if(bytes.byteLength>HASH_DIAGNOSTIC_LIMITS.inputBytes){state.untrackedCalls++;return;}
 let input;try{input=decoder.decode(bytes);}catch{state.invalidUtf8Calls++;state.untrackedCalls++;return;}
 if(privateState.inputs.has(input)){state.trackedCalls++;state.duplicateCalls++;state.duplicateInputBytes+=bytes.byteLength;group.trackedCalls++;group.duplicateCalls++;group.duplicateInputBytes+=bytes.byteLength;return;}
 if(privateState.inputs.size>=HASH_DIAGNOSTIC_LIMITS.uniqueInputs||state.retainedUtf8Bytes+bytes.byteLength>HASH_DIAGNOSTIC_LIMITS.retainedUtf8Bytes){state.untrackedCalls++;return;}
 privateState.inputs.add(input);state.uniqueInputs++;state.retainedUtf8Bytes+=bytes.byteLength;state.trackedCalls++;group.trackedCalls++;
}
/** Installs only in the isolated opt-in benchmark. Every invocation calls the
 * original native digest exactly once and returns its SAME promise/rejection.
 * No digest/result is retained; exact valid UTF8 bytes are counted only.
 * The caller's ALS sink chooses a request-local frame; no cross-request set. */
export function installHashCallDiagnostics(subtle,currentFrame){
 const own=Object.getOwnPropertyDescriptor(subtle,'digest'),native=subtle.digest;
 function observed(algorithm,data){
  const result=Reflect.apply(native,subtle,[algorithm,data]);
  let scope;try{scope=currentFrame();if(scope)record(scope.state,scope.phase,algorithm,data);}catch{if(scope?.state)scope.state.diagnosticFailures++;}
  return result;
 }
 Object.defineProperty(subtle,'digest',{value:observed,writable:true,configurable:true,enumerable:own?.enumerable??false});
 return ()=>{if(subtle.digest!==observed)return;if(own)Object.defineProperty(subtle,'digest',own);else delete subtle.digest;};
}
export function finishHashCallFrame(state){
 const privateState=states.get(state);if(privateState){privateState.closed=true;privateState.inputs.clear();states.delete(state);}
 // Explicit projection: never serialize the private set or any key/bytes/digest.
 return {nativeDigestCalls:state.nativeDigestCalls,sha256Calls:state.sha256Calls,trackedCalls:state.trackedCalls,duplicateCalls:state.duplicateCalls,uniqueInputs:state.uniqueInputs,inputBytes:state.inputBytes,duplicateInputBytes:state.duplicateInputBytes,retainedUtf8Bytes:state.retainedUtf8Bytes,untrackedCalls:state.untrackedCalls,invalidUtf8Calls:state.invalidUtf8Calls,diagnosticFailures:state.diagnosticFailures,byPhase:state.byPhase};
}
