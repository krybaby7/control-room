import http from 'node:http';
import {projectLabReport} from './agent-lab-import.mjs';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {BRIDGE_LIMITS,opaqueId,timestamp,canonicalJson} from './config.mjs';
export const AGENT_LAB_READS=Object.freeze({state:'http://127.0.0.1:4317/api/state',report:'http://127.0.0.1:4317/api/report'});
export const AGENT_LAB_LIMITS=Object.freeze({runs:1000,responseBytes:BRIDGE_LIMITS.responseBytes,deadlineMs:BRIDGE_LIMITS.localDeadlineMs});
const statuses=new Set(['queued','running','completed','failed','timed_out','cancelled','blocked','rate_limited','interrupted']);
const providers=new Set(['codex','claude']),efforts=new Set(['low','medium','high','xhigh','max','ultra']);
class LabReadError extends Error{constructor(code){super(code);this.code=code;}}
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const safe=(value,max=128)=>typeof value==='string'&&value.length<=max&&/^[A-Za-z0-9][A-Za-z0-9.+_:-]*$/u.test(value)?value:null;
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1000000?value:null;
const stamp=value=>{try{return timestamp(value);}catch{return null;}};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)?value:null;
function runId(value){try{return opaqueId(value);}catch{throw new LabReadError('source_invalid');}}
function cohort(run){
 const fields={provider:run.provider,requestedModel:run.requestedModel,observedModel:run.observedModel,runtimeVersion:run.runtimeVersion,runtimeToolPolicy:run.runtimeToolPolicy,promptMode:run.promptMode,effort:run.effort,taskId:run.taskId,taskVersion:run.taskVersion,fixtureHash:run.fixtureHash};
 if(Object.values(fields).some(value=>value===null))return null;
 return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}
/** Source claims are evaluation context, never model readiness or job authority.
 * Legacy display projection keeps grades/usage unknown. Explicit selected
 * imports use the separately bounded projection in agent-lab-import.mjs. */
export function sanitizeAgentLabRun(raw){
 if(!plain(raw))throw new LabReadError('source_invalid');
 const id=runId(raw.id),provider=providers.has(raw.provider)?raw.provider:null,requestedModel=safe(raw.requestedModel),observedModel=safe(raw.observedModel),reportedModelVerified=typeof raw.modelVerified==='boolean'?raw.modelVerified:null;
 const review=plain(raw.review)?raw.review:{},verdict=['pending','accepted','rejected','needs-review','pass','fail'].includes(review.verdict)?review.verdict:null;
 const value={id,taskId:safe(raw.taskId),taskVersion:Number.isSafeInteger(raw.taskVersion)&&raw.taskVersion>=1&&raw.taskVersion<=1000000?raw.taskVersion:null,fixtureHash:digest(raw.fixtureHash),provider,requestedModel,observedModel,reportedModelVerified,modelVerified:reportedModelVerified===true&&provider!==null&&requestedModel!==null&&observedModel!==null&&requestedModel===observedModel,identityProvenance:'upstream-claim',runtimeVersion:safe(raw.runtimeVersion),runtimeToolPolicy:safe(raw.runtimeToolPolicy),promptMode:['structured','response','edit'].includes(raw.promptMode)?raw.promptMode:null,effort:efforts.has(raw.effort)?raw.effort:null,status:statuses.has(raw.status)?raw.status:null,grade:null,review:{verdict,minutes:nonnegative(review.minutes),corrections:Number.isSafeInteger(review.corrections)&&review.corrections>=0&&review.corrections<=1000000?review.corrections:null},usage:null,createdAt:stamp(raw.createdAt),finishedAt:stamp(raw.finishedAt),cohortSha256:null,limitations:[]};
 if(value.createdAt&&value.finishedAt&&Date.parse(value.finishedAt)<Date.parse(value.createdAt)){value.finishedAt=null;value.limitations.push('source_clock_order_unverified');}
 if(raw.grade!==null&&raw.grade!==undefined)value.limitations.push('objective_grade_schema_unverified');
 if(raw.usage!==null&&raw.usage!==undefined)value.limitations.push('usage_schema_unverified');
 if(reportedModelVerified===true&&!value.modelVerified)value.limitations.push('model_identity_unverified');
 if(value.status===null)value.limitations.push('source_status_unknown');
 value.cohortSha256=cohort(value);if(value.cohortSha256===null)value.limitations.push('cohort_identity_incomplete');
 return value;
}
export function sanitizeAgentLabState(raw,{instanceId,observedAt}){
 opaqueId(instanceId);timestamp(observedAt);
 if(!plain(raw)||!Array.isArray(raw.runs)||raw.runs.length>AGENT_LAB_LIMITS.runs||!plain(raw.queue))throw new LabReadError('source_invalid');
 const runs=raw.runs.map(sanitizeAgentLabRun);if(new Set(runs.map(run=>run.id)).size!==runs.length)throw new LabReadError('source_invalid');
 return {schemaVersion:1,source:'agent-lab',instanceId,observedAt,sourceVersion:safe(raw.version,64),availability:runs.length?'available':'no-runs',diagnostic:'ok',queue:{paused:typeof raw.queue.paused==='boolean'?raw.queue.paused:null,active:raw.queue.activeId===null?false:typeof raw.queue.activeId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(raw.queue.activeId)?true:null},runs};
}
function readFixed(path,{deadlineMs,report=false}){
 return new Promise((resolve,reject)=>{
  const agent=new http.Agent({keepAlive:false});agent.createConnection=()=>net.createConnection({host:'127.0.0.1',port:4317});
  let request,response,settled=false;
  const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){response?.destroy();request?.destroy();}agent.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>done(new LabReadError('source_unreachable')),deadlineMs);
  request=http.get({protocol:'http:',hostname:'127.0.0.1',port:4317,path,agent,headers:{Accept:report?'application/json, text/plain, text/markdown':'application/json',Connection:'close'}},incoming=>{
   response=incoming;
   if(incoming.statusCode!==200)return done(new LabReadError(incoming.statusCode>=500?'source_unreachable':'source_invalid'));
   const type=incoming.headers['content-type']??'',json=/^application\/json(?:\s*;|$)/iu.test(type);
   if(!json&&!(report&&/^text\/(?:plain|markdown)(?:\s*;|$)/iu.test(type)))return done(new LabReadError('source_invalid'));
   const length=incoming.headers['content-length'];if(length!==undefined&&(!/^\d+$/u.test(length)||Number(length)>AGENT_LAB_LIMITS.responseBytes))return done(new LabReadError('source_invalid'));
   let bytes=0;const chunks=[];
   incoming.on('data',chunk=>{bytes+=chunk.length;if(bytes>AGENT_LAB_LIMITS.responseBytes)return done(new LabReadError('source_invalid'));chunks.push(chunk);});
   incoming.on('aborted',()=>done(new LabReadError('source_invalid')));incoming.on('error',()=>done(new LabReadError('source_unreachable')));
   incoming.on('end',()=>{try{if(length!==undefined&&Number(length)!==bytes)throw new Error();const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(report)return done(null,{value:json?JSON.parse(text):null,sourceInputSha256:createHash('sha256').update(Buffer.concat(chunks)).digest('hex')});done(null,JSON.parse(text));}catch{done(new LabReadError('source_invalid'));}});
  });request.on('error',()=>done(new LabReadError('source_unreachable')));
 });
}
function unavailable(instanceId,observedAt,diagnostic,availability='unavailable'){return {schemaVersion:1,source:'agent-lab',instanceId,observedAt,sourceVersion:null,availability,diagnostic,queue:{paused:null,active:null},runs:[]};}
/** Separate explicit reader, never wired into routine PC sampling. No endpoint,
 * header, credential, proxy or write-method override is accepted. */
export function createAgentLabReader(options={}){
 if(!plain(options)||Object.keys(options).some(key=>!['enabled','instanceId','now','deadlineMs'].includes(key)))throw new Error('Invalid Agent Lab reader options.');
 const {enabled=false,instanceId='agent-lab',now=()=>new Date().toISOString(),deadlineMs=AGENT_LAB_LIMITS.deadlineMs}=options;
 opaqueId(instanceId);if(typeof enabled!=='boolean'||typeof now!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>AGENT_LAB_LIMITS.deadlineMs)throw new Error('Invalid Agent Lab reader options.');
 const dated=()=>timestamp(now()),diagnostic=error=>error instanceof LabReadError?error.code:'source_invalid';
 return Object.freeze({
  async readState(){const observedAt=dated();if(!enabled)return unavailable(instanceId,observedAt,'not_configured','disabled');try{return sanitizeAgentLabState(await readFixed('/api/state',{deadlineMs}),{instanceId,observedAt});}catch(error){return unavailable(instanceId,observedAt,diagnostic(error));}},
  async readRun(id){const selected=runId(id),observedAt=dated();if(!enabled)return {instanceId,observedAt,available:false,reason:'not_configured',run:null};try{const run=sanitizeAgentLabRun(await readFixed('/api/runs/'+encodeURIComponent(selected),{deadlineMs}));if(run.id!==selected)throw new LabReadError('source_invalid');return {instanceId,observedAt,available:true,reason:'source-claim',run};}catch(error){return {instanceId,observedAt,available:false,reason:diagnostic(error),run:null};}},
  async readReport(){const observedAt=dated();if(!enabled)return {instanceId,observedAt,available:false,reason:'not_configured'};try{const raw=await readFixed('/api/report',{deadlineMs,report:true});if(!plain(raw.value)||!Array.isArray(raw.value.comparisons))return {instanceId,observedAt,available:false,reason:'unsupported-report-schema'};return {instanceId,observedAt,available:true,reason:'source-claim',sourceInputSha256:raw.sourceInputSha256,report:projectLabReport(raw.value)};}catch(error){return {instanceId,observedAt,available:false,reason:diagnostic(error)};}},
 });
}
