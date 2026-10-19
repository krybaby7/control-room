import http from 'node:http';
import net from 'node:net';
import {performance} from 'node:perf_hooks';
import {BRIDGE_LIMITS,opaqueId,timestamp,validateGpuSelection} from './config.mjs';
export {BRIDGE_LIMITS} from './config.mjs';
export const PC_READS=Object.freeze({health:'http://127.0.0.1:47631/api/health',summary:'http://127.0.0.1:47631/api/snapshot?detail=summary'});
class LocalReadError extends Error{constructor(diagnostic){super(diagnostic);this.diagnostic=diagnostic;}}
function readFixedJson(alias){
 return new Promise((resolve,reject)=>{
  const agent=new http.Agent({keepAlive:false});agent.createConnection=()=>net.createConnection({host:'127.0.0.1',port:47631});
  let request,response,settled=false;
  const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){response?.destroy();request?.destroy();}agent.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>done(new LocalReadError('source_unreachable')),BRIDGE_LIMITS.localDeadlineMs);
  request=http.get(PC_READS[alias],{agent,headers:{Accept:'application/json',Connection:'close'}},incoming=>{
   response=incoming;
   if(incoming.statusCode!==200)return done(new LocalReadError(incoming.statusCode>=500?'source_unreachable':'source_invalid'));
   if(!/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type']??''))return done(new LocalReadError('source_invalid'));
   const length=incoming.headers['content-length'];
   if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>BRIDGE_LIMITS.responseBytes))return done(new LocalReadError('source_invalid'));
   let bytes=0;const chunks=[];
   incoming.on('data',chunk=>{bytes+=chunk.length;if(bytes>BRIDGE_LIMITS.responseBytes)return done(new LocalReadError('source_invalid'));chunks.push(chunk);});
   incoming.on('aborted',()=>done(new LocalReadError('source_invalid')));
   incoming.on('error',()=>done(new LocalReadError('source_unreachable')));
   incoming.on('end',()=>{try{if(length!==undefined&&Number(length)!==bytes)throw new Error();done(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{done(new LocalReadError('source_invalid'));}});
  });request.on('error',()=>done(new LocalReadError('source_unreachable')));
 });
}
const number=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null;
const bytes=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const emptyMetrics=()=>({cpuPercent:null,memoryPercent:null,gpuUtilizationPercent:null,gpuMemoryUsedBytes:null,gpuMemoryTotalBytes:null,gpuTemperatureC:null,diskReadBytesPerSec:null,diskWriteBytesPerSec:null,networkSentBytesPerSec:null,networkReceivedBytesPerSec:null});
const unavailable=(instanceId,diagnostic,selectedGpuAlias)=>({source:'pc-command-center',instanceId,selectedGpuAlias,observedAt:null,reportedAgeSeconds:null,state:'unavailable',diagnostic,metrics:null});
export function sanitizePcCommandCenter(health,summary,{instanceId,selectedGpuId=null,selectedGpuAlias=null,elapsedMs=0}){
 opaqueId(instanceId);validateGpuSelection({selectedGpuId,selectedGpuAlias});
 if(!health||typeof health!=='object'||health.app!=='pc-command-center'||typeof health.ready!=='boolean'||typeof health.worker_alive!=='boolean'||typeof health.collector_state!=='string'||!summary||typeof summary!=='object'||summary.schema_version!==1)return unavailable(instanceId,'source_invalid',selectedGpuAlias);
 let observedAt;try{observedAt=timestamp(summary.timestamp);}catch{return unavailable(instanceId,'source_invalid',selectedGpuAlias);}
 let reportedAgeSeconds=null;try{timestamp(health.last_sample_at);if(Date.parse(health.last_sample_at)===Date.parse(observedAt)&&number(health.sample_age_seconds,0,86400)!==null&&number(elapsedMs,0,4000)!==null)reportedAgeSeconds=health.sample_age_seconds+elapsedMs/1000;}catch{}
 const metrics=emptyMetrics();metrics.cpuPercent=number(summary.cpu?.percent,0,100);metrics.memoryPercent=number(summary.memory?.percent,0,100);
 const selected=selectedGpuId===null?[]:(Array.isArray(summary.gpus)?summary.gpus:[]).filter(gpu=>gpu&&gpu.id===selectedGpuId);
 const gpuMissing=selectedGpuId!==null&&selected.length!==1;
 if(selected.length===1){const gpu=selected[0];metrics.gpuUtilizationPercent=number(gpu.utilization_percent,0,100);metrics.gpuMemoryUsedBytes=bytes(gpu.memory_used_bytes);metrics.gpuMemoryTotalBytes=bytes(gpu.memory_total_bytes);metrics.gpuTemperatureC=number(gpu.temperature_c,-50,150);if(metrics.gpuMemoryUsedBytes!==null&&metrics.gpuMemoryTotalBytes!==null&&metrics.gpuMemoryUsedBytes>metrics.gpuMemoryTotalBytes){metrics.gpuMemoryUsedBytes=null;metrics.gpuMemoryTotalBytes=null;}}
 metrics.diskReadBytesPerSec=number(summary.disk_io?.read_bytes_per_sec);metrics.diskWriteBytesPerSec=number(summary.disk_io?.write_bytes_per_sec);metrics.networkSentBytesPerSec=number(summary.network?.sent_bytes_per_sec);metrics.networkReceivedBytesPerSec=number(summary.network?.received_bytes_per_sec);
 const ready=health.ready&&health.worker_alive&&health.collector_state==='running'&&reportedAgeSeconds!==null&&reportedAgeSeconds<=10&&!gpuMissing;
 return {source:'pc-command-center',instanceId,selectedGpuAlias,observedAt,reportedAgeSeconds,state:ready?'ready':['starting','warming'].includes(health.collector_state)?'warming':'degraded',diagnostic:gpuMissing?'source_invalid':ready?'ok':'source_stale',metrics};
}
export async function samplePcCommandCenter({instanceId,selectedGpuId=null,selectedGpuAlias=null,now=()=>new Date().toISOString()}){
 opaqueId(instanceId);validateGpuSelection({selectedGpuId,selectedGpuAlias});timestamp(now());const start=performance.now();
 try{const [health,summary]=await Promise.all([readFixedJson('health'),readFixedJson('summary')]);return sanitizePcCommandCenter(health,summary,{instanceId,selectedGpuId,selectedGpuAlias,elapsedMs:performance.now()-start});}catch(error){return unavailable(instanceId,error instanceof LocalReadError?error.diagnostic:'source_invalid',selectedGpuAlias);}
}
