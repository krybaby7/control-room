import {createHash} from 'node:crypto';
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonicalJson,timestamp} from './config.mjs';
import {assertExecutionArtifactContent} from '../executor/content-policy.mjs';

export const LAB_IMPORT_LIMITS=Object.freeze({bytes:262144,uploadBytes:65536,runs:200,nodes:10000,depth:20,checks:200,cohorts:200});
const statuses=new Set(['passed','queued','running','completed','failed','timed_out','cancelled','blocked','rate_limited','interrupted']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function bad(){throw new Error('Selected evaluation input is invalid or exceeds its bound.');}
const hash=value=>createHash('sha256').update(value).digest('hex');
function token(value,max=128){return typeof value==='string'&&value.length<=max&&/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)?value:null;}
function required(value,max=128){const result=token(value,max);if(result===null)bad();return result;}
function count(value,max=Number.MAX_SAFE_INTEGER){return Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;}
function metric(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:null;}
function date(value){try{return timestamp(value);}catch{return null;}}
function decode(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>LAB_IMPORT_LIMITS.bytes)bad();
 let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{bad();}
 const pending=[[raw,0]];let nodes=0;
 while(pending.length){const [value,depth]=pending.pop();if(++nodes>LAB_IMPORT_LIMITS.nodes||depth>LAB_IMPORT_LIMITS.depth)bad();
  if(value===null||typeof value==='string'||typeof value==='boolean')continue;
  if(typeof value==='number'){if(!Number.isFinite(value))bad();continue;}
  if(Array.isArray(value)){for(const child of value)pending.push([child,depth+1]);continue;}
  if(!plain(value))bad();for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value))){if(['__proto__','prototype','constructor'].includes(key)||!Object.hasOwn(descriptor,'value'))bad();pending.push([descriptor.value,depth+1]);}
 }
 return raw;
}
function objective(raw){
 if(raw.grade===null||raw.grade===undefined)return null;
 if(raw.runtimeBlock!==null&&raw.runtimeBlock!==undefined)return {assessable:false,passed:null,score:null,checksPassed:null,checksTotal:null};
 if(!['passed','failed'].includes(raw.status))return null;
 const grade=raw.grade;if(!plain(grade)||typeof grade.passed!=='boolean'||metric(grade.score)===null||!Array.isArray(grade.checks)||grade.checks.length>LAB_IMPORT_LIMITS.checks||grade.checks.some(check=>!plain(check)||typeof check.passed!=='boolean'))bad();
 if((raw.status==='passed')!==grade.passed)bad();
 return {assessable:true,passed:grade.passed,score:grade.score,checksPassed:grade.checks.filter(check=>check.passed).length,checksTotal:grade.checks.length};
}
/** Original allowlist projection of a selected source claim; never runtime authority. */
export function projectLabRun(raw){
 if(!plain(raw)||!statuses.has(raw.status))bad();
 const createdAt=date(raw.createdAt),finishedAt=raw.finishedAt===null||raw.finishedAt===undefined?null:date(raw.finishedAt);
 if(!createdAt||raw.finishedAt!==null&&raw.finishedAt!==undefined&&!finishedAt||finishedAt&&Date.parse(finishedAt)<Date.parse(createdAt))bad();
 const taskVersion=count(raw.taskVersion);if(!taskVersion||typeof raw.fixtureHash!=='string'||!/^[a-f0-9]{64}$/u.test(raw.fixtureHash))bad();
 const observedModels=Array.isArray(raw.observedModels)?raw.observedModels:null,requestedModel=token(raw.requestedModel),observedModel=token(raw.observedModel),review=plain(raw.review)?raw.review:{};
 const reportedMatch=raw.modelVerified===true&&['codex','claude'].includes(raw.provider)&&requestedModel!==null&&observedModel===requestedModel&&(!observedModels||observedModels.length===1&&observedModels[0]===requestedModel);
 return {id:required(raw.id),taskId:required(raw.taskId),taskVersion,fixtureHash:raw.fixtureHash,provider:['codex','claude'].includes(raw.provider)?raw.provider:null,requestedModel,observedModel,modelVerified:reportedMatch,runtimeVersion:token(raw.runtimeVersion),runtimeToolPolicy:token(raw.runtimeToolPolicy),promptMode:token(raw.promptMode),effort:['low','medium','high','xhigh','max','ultra'].includes(raw.effort)?raw.effort:null,status:raw.status==='passed'?'completed':raw.status,grade:null,review:{verdict:['accepted','rejected','pending'].includes(review.verdict)?review.verdict:'unknown',minutes:metric(review.minutes),corrections:count(review.corrections)},usage:null,createdAt,finishedAt,sourceStatus:raw.status,sourceInputSha256:hash(canonicalJson(raw)),objective:objective(raw)};
}
const cohortFields=['provider','runtimeVersion','runtimeToolPolicy','taskId','taskVersion','fixtureHash','taskMode','promptMode','effort','requestedModel'];
function projectCohort(raw){
 if(!plain(raw))bad();
 const identity={};for(const key of cohortFields)identity[key]=key==='taskVersion'?(count(raw[key])===0?null:count(raw[key])):key==='fixtureHash'?(typeof raw[key]==='string'&&/^[a-f0-9]{64}$/u.test(raw[key])?raw[key]:null):token(raw[key]);
 const names=['samples','finished','assessable','objectiveFailures','blocked','passed','accepted','rejected','reviewed','reviewMinuteRecords','correctionRecords','usageReported','verifiedModels'],counts={};
 for(const key of names){counts[key]=count(raw[key],1000000);if(counts[key]===null)bad();}
 if(counts.finished>counts.samples||counts.assessable>counts.finished||counts.objectiveFailures+counts.passed>counts.assessable||counts.reviewed>counts.finished||counts.accepted+counts.rejected>counts.reviewed||counts.verifiedModels>counts.finished||counts.usageReported>counts.finished||counts.reviewMinuteRecords>counts.finished||counts.correctionRecords>counts.finished||counts.blocked>counts.finished)bad();
 if(!plain(raw.statuses)||Object.keys(raw.statuses).some(key=>!statuses.has(key)))bad();const statusCounts={};for(const [key,value]of Object.entries(raw.statuses)){if(count(value,1000000)===null)bad();statusCounts[key]=value;}
 if(Object.values(statusCounts).reduce((a,b)=>a+b,0)!==counts.samples)bad();
 const known=Object.values(identity).every(value=>value!==null);
 return {...identity,cohortSha256:known?hash(canonicalJson(identity)):null,counts,statuses:statusCounts,reviewMinutes:metric(raw.reviewMinutes),corrections:metric(raw.corrections),meanDurationMs:metric(raw.meanDurationMs),usage:null,costDollars:null,sourceClaimsOnly:true};
}
/** Report aggregates remain local review context. They cannot create per-run facts. */
export function projectLabReport(raw){
 if(!plain(raw)||!Array.isArray(raw.comparisons)||raw.comparisons.length>LAB_IMPORT_LIMITS.cohorts)bad();
 const cohorts=raw.comparisons.map(projectCohort),known=cohorts.map(row=>row.cohortSha256).filter(Boolean);if(new Set(known).size!==known.length)bad();
 const result={kind:'report',cohorts,limitations:['Aggregate upstream claims only; no per-run evidence, readiness, cost savings or owner acceptance is inferred.']};const projected=Buffer.from(canonicalJson(result));if(projected.byteLength>LAB_IMPORT_LIMITS.uploadBytes-1024)bad();assertExecutionArtifactContent(projected);return result;
}
/** Input must be an explicitly supplied local export, never a state/token fetch.
 * Only selected run summaries are projected; originals remain owner controlled.
 * @param {Uint8Array} bytes
 * @param {{kind:'run'|'summary'|'report',sourceInstance:string,selectedRunIds?:string[],version?:string|null}} options
 */
export function projectLabImport(bytes,{kind,sourceInstance,selectedRunIds=[],version=null}){
 if(!['run','summary','report'].includes(kind)||!Array.isArray(selectedRunIds)||selectedRunIds.length>LAB_IMPORT_LIMITS.runs||new Set(selectedRunIds).size!==selectedRunIds.length)bad();
 sourceInstance=required(sourceInstance,64);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sourceInstance))bad();selectedRunIds.forEach(id=>required(id));
 const raw=decode(bytes),sourceInputSha256=hash(bytes);let result;
 if(kind==='report'){if(selectedRunIds.length)bad();result={...projectLabReport(raw),sourceInstance,sourceInputSha256};}
 else{
  const list=kind==='run'?[raw]:plain(raw)&&Array.isArray(raw.runs)?raw.runs:null;if(!list||list.length>LAB_IMPORT_LIMITS.runs||!selectedRunIds.length)bad();
  const ids=list.map(row=>plain(row)?required(row.id):bad());if(new Set(ids).size!==ids.length||selectedRunIds.some(id=>!ids.includes(id)))bad();
  const sourceVersion=required(kind==='summary'?raw.version:version),runs=selectedRunIds.map(id=>projectLabRun(list[ids.indexOf(id)]));
  const upload={schemaVersion:1,sourceFormatVersion:1,sourceInstance,version:sourceVersion,runs};
  if(Buffer.byteLength(canonicalJson(upload))>LAB_IMPORT_LIMITS.uploadBytes)bad();
  result={kind:'runs',sourceInputSha256,upload,limitations:['Historical source claims only. Objective grading, human review and model identity claims are separate. Cost/usage remain unknown. Original-input digests are source claims, not server verification of original bytes.']};
 }
 const projected=Buffer.from(canonicalJson(result));if(projected.byteLength>LAB_IMPORT_LIMITS.uploadBytes-1)bad();assertExecutionArtifactContent(projected);return result;
}
async function readLocal(path){
 if(typeof path!=='string'||!isAbsolute(path)||path.startsWith('\\\\')||/[\r\n\0]/u.test(path))bad();
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.size>LAB_IMPORT_LIMITS.bytes||await realpath(path)!==path)bad();
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const stat=await file.stat();if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.size!==before.size)bad();const chunks=[];let size=0;for await(const chunk of file.createReadStream({highWaterMark:4096,autoClose:false})){size+=chunk.length;if(size>LAB_IMPORT_LIMITS.bytes)bad();chunks.push(chunk);}const after=await file.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)bad();return Buffer.concat(chunks);}finally{await file.close();}
}
export async function importLabMain(argv,{write=value=>process.stdout.write(value)}={}){
 if(argv.length>410||argv.length%2)bad();const fields={},selectedRunIds=[];for(let index=0;index<argv.length;index+=2){const key=argv[index],value=argv[index+1];if(!value||!['--input','--kind','--instance','--version','--run'].includes(key))bad();if(key==='--run')selectedRunIds.push(value);else{if(Object.hasOwn(fields,key))bad();fields[key]=value;}}
 if(!fields['--input']||!fields['--kind']||!fields['--instance'])bad();
 const result=projectLabImport(await readLocal(fields['--input']),{kind:fields['--kind'],sourceInstance:fields['--instance'],selectedRunIds,version:fields['--version']??null});
 write(canonicalJson(result)+'\n');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)importLabMain(process.argv.slice(2)).catch(()=>{process.stderr.write('Selected evaluation import was refused. No upload or execution was performed.\n');process.exitCode=1;});
