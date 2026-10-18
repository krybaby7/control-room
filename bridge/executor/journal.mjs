import {open,mkdir,lstat,realpath,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join,dirname,parse as parsePath} from 'node:path';
import {randomUUID} from 'node:crypto';
import {shape,id,alias,digest,integer,bool,choice,stamp,canonical,sha,fail,ExecutorError,model,DIAGNOSTICS,fileKey} from './codec.mjs';
export const JOURNAL_LIMITS=Object.freeze({bytes:10*1024*1024,records:10000,artifactBytes:10*1024*1024});
const phases=['claimed','workspace_ready','launch_intent','process_started','process_exited','result_uploaded','acknowledged','reconcile_required','blocked'];
const transitions={claimed:['workspace_ready','blocked'],workspace_ready:['launch_intent','blocked'],launch_intent:['process_started','reconcile_required'],process_started:['process_exited','reconcile_required'],process_exited:['result_uploaded','reconcile_required'],result_uploaded:['acknowledged','reconcile_required'],acknowledged:[],reconcile_required:[],blocked:[]};
function identity(raw){shape(raw,['jobId','attemptId','deviceId','epoch','specSha256']);return {jobId:id(raw.jobId),attemptId:id(raw.attemptId),deviceId:id(raw.deviceId),epoch:integer(raw.epoch),specSha256:digest(raw.specSha256)};}
function processIdentity(raw){if(raw===null)return null;shape(raw,['pid','startedAt','supervisorId','ownershipSha256']);return {pid:integer(raw.pid,1),startedAt:stamp(raw.startedAt),supervisorId:id(raw.supervisorId),ownershipSha256:digest(raw.ownershipSha256)};}
function event(raw,owner){
 shape(raw,['schemaVersion','attemptId','epoch','sequence','kind','observedAt','diagnostic','details']);if(raw.schemaVersion!==1||raw.attemptId!==owner.attemptId||raw.epoch!==owner.epoch)fail('event_identity_differs');integer(raw.sequence,1);stamp(raw.observedAt);choice(raw.diagnostic,DIAGNOSTICS);
 const fields={accepted:['specSha256','capabilitySha256'],started:['runtimePackageSha256','toolPolicySha256','requestedModel','observedModel'],progress:['stage','completedUnits','totalUnits'],cancel_acknowledged:['requestId','exitConfirmed'],process_exit:['exitCode','processExitConfirmed','terminationUnconfirmed'],artifact_ready:['artifactId','sha256','bytes','type'],completed:['resultSha256'],blocked:['reason']};
 choice(raw.kind,Object.keys(fields));shape(raw.details,fields[raw.kind]);const d=raw.details;
 if(raw.kind==='accepted'){if(d.specSha256!==owner.specSha256)fail('event_spec_differs');digest(d.capabilitySha256);}
 if(raw.kind==='started'){digest(d.runtimePackageSha256);digest(d.toolPolicySha256);model(d.requestedModel);if(d.observedModel!==null)model(d.observedModel);}
 if(raw.kind==='progress'){choice(d.stage,['preparing','executing','validating','uploading']);integer(d.completedUnits,0,10000);if(d.totalUnits!==null)integer(d.totalUnits,0,10000);if(d.totalUnits!==null&&d.completedUnits>d.totalUnits)fail('invalid_progress');}
 if(raw.kind==='cancel_acknowledged'){id(d.requestId);bool(d.exitConfirmed);}
 if(raw.kind==='process_exit'){if(d.exitCode!==null)integer(d.exitCode,-255,255);bool(d.processExitConfirmed);bool(d.terminationUnconfirmed);if(d.processExitConfirmed&&d.terminationUnconfirmed)fail('contradictory_exit');}
 if(raw.kind==='artifact_ready'){id(d.artifactId);digest(d.sha256);integer(d.bytes,0,JOURNAL_LIMITS.artifactBytes);choice(d.type,['text/plain','text/markdown','text/x-diff','application/json']);}
 if(raw.kind==='completed')digest(d.resultSha256);
 if(raw.kind==='blocked')choice(d.reason,DIAGNOSTICS);
 return JSON.parse(canonical(raw));
}
function artifact(raw){shape(raw,['id','filename','contentType','bytes','sha256','relativePath']);fileKey(raw.id);fileKey(raw.filename);if(typeof raw.filename!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(raw.filename)||raw.filename.includes('..'))fail('unsafe_artifact_name');choice(raw.contentType,['text/plain','text/markdown','text/x-diff','application/json']);integer(raw.bytes,0,JOURNAL_LIMITS.artifactBytes);digest(raw.sha256);if(raw.relativePath!=='artifacts/'+raw.id)fail('unsafe_artifact_path');return JSON.parse(canonical(raw));}
function result(raw,owner){
 shape(raw,['attemptId','epoch','disposition','requestedModel','observedModel','modelVerified','terminalProtocolObserved','processExitConfirmed','terminationUnconfirmed','artifactIds','usage','diagnostic']);if(raw.attemptId!==owner.attemptId||raw.epoch!==owner.epoch)fail('result_identity_differs');choice(raw.disposition,['succeeded','failed','cancelled','blocked']);model(raw.requestedModel);if(raw.observedModel!==null)model(raw.observedModel);for(const key of ['modelVerified','terminalProtocolObserved','processExitConfirmed','terminationUnconfirmed'])bool(raw[key]);if(raw.modelVerified&&(raw.observedModel===null||raw.observedModel!==raw.requestedModel))fail('model_identity_differs');if(raw.terminationUnconfirmed&&raw.processExitConfirmed)fail('contradictory_exit');if(['succeeded','cancelled'].includes(raw.disposition)&&(!raw.processExitConfirmed||raw.terminationUnconfirmed))fail('unconfirmed_terminal');if(raw.disposition==='succeeded'&&!raw.terminalProtocolObserved)fail('terminal_protocol_unverified');if(!Array.isArray(raw.artifactIds)||raw.artifactIds.length>100||new Set(raw.artifactIds.map(id)).size!==raw.artifactIds.length)fail('invalid_artifacts');choice(raw.diagnostic,DIAGNOSTICS);
 if(raw.usage!==null){shape(raw.usage,['inputTokens','outputTokens','runtimeSeconds','costDollars']);for(const key of ['inputTokens','outputTokens'])if(raw.usage[key]!==null)integer(raw.usage[key]);for(const [key,max]of [['runtimeSeconds',600],['costDollars',Number.MAX_SAFE_INTEGER]])if(raw.usage[key]!==null&&(typeof raw.usage[key]!=='number'||!Number.isFinite(raw.usage[key])||raw.usage[key]<0||raw.usage[key]>max))fail('invalid_usage');}
 return JSON.parse(canonical(raw));
}
function entry(raw,owner){shape(raw,['kind','value']);choice(raw.kind,['phase','event','artifact','result','receipt']);if(raw.kind==='phase'){shape(raw.value,['phase','workspaceKey','processIdentity','nextEventSequence']);choice(raw.value.phase,phases);if(raw.value.workspaceKey!==null){alias(raw.value.workspaceKey);fileKey(raw.value.workspaceKey);}processIdentity(raw.value.processIdentity);integer(raw.value.nextEventSequence);return JSON.parse(canonical(raw));}if(raw.kind==='event')return {kind:raw.kind,value:event(raw.value,owner)};if(raw.kind==='artifact')return {kind:raw.kind,value:artifact(raw.value)};if(raw.kind==='result')return {kind:raw.kind,value:result(raw.value,owner)};shape(raw.value,['target','id','sha256','receivedAt']);choice(raw.value.target,['event','artifact','result']);id(raw.value.id);digest(raw.value.sha256);stamp(raw.value.receivedAt);return JSON.parse(canonical(raw));}
function initial(owner){return {identity:owner,records:[],phase:null,workspaceKey:null,processIdentity:null,nextEventSequence:1,queued:new Map(),receipts:new Map(),artifactBytes:0};}
function apply(state,value){
 const v=value.value;
 if(value.kind==='phase'){
  if(state.phase===null?v.phase!=='claimed':!transitions[state.phase].includes(v.phase))fail('invalid_journal_transition');
  if(v.nextEventSequence!==state.nextEventSequence)fail('event_sequence_differs');
  if(state.workspaceKey!==null&&v.workspaceKey!==state.workspaceKey)fail('workspace_identity_differs');
  if(['workspace_ready','launch_intent','process_started','process_exited','result_uploaded','acknowledged'].includes(v.phase)&&v.workspaceKey===null)fail('workspace_identity_missing');
  if(v.phase==='process_started'&&v.processIdentity===null)fail('owned_process_identity_required');
  if(state.processIdentity!==null&&canonical(v.processIdentity)!==canonical(state.processIdentity))fail('owned_process_identity_differs');
  if(['claimed','workspace_ready','launch_intent','blocked'].includes(v.phase)&&v.processIdentity!==null)fail('unexpected_process_identity');
  if(v.phase==='result_uploaded'&&(!state.queued.has('result:'+state.identity.attemptId)||[...state.queued].some(([key])=>key.startsWith('result:')||key.startsWith('artifact:')?!state.receipts.has(key):false)))fail('result_receipt_required');
  if(v.phase==='acknowledged'&&[...state.queued.keys()].some(key=>!state.receipts.has(key)))fail('unacknowledged_execution_data');
  state.phase=v.phase;state.workspaceKey=v.workspaceKey;state.processIdentity=v.processIdentity;
 }else if(value.kind==='receipt'){
  const key=v.target+':'+v.id,queued=state.queued.get(key);if(!queued||sha(queued.value)!==v.sha256)fail('receipt_identity_differs');if(state.receipts.has(key)&&canonical(state.receipts.get(key))!==canonical(v))fail('receipt_identity_differs');state.receipts.set(key,v);
 }else{
  const key=value.kind+':'+(value.kind==='event'?String(v.sequence):value.kind==='result'?state.identity.attemptId:v.id);if(state.queued.has(key))fail('duplicate_journal_identity');
  if(value.kind==='event'){if(v.sequence!==state.nextEventSequence)fail('event_sequence_differs');state.nextEventSequence++;}
  if(value.kind==='artifact'){state.artifactBytes+=v.bytes;if(state.artifactBytes>JOURNAL_LIMITS.artifactBytes)fail('journal_capacity');}
  if(value.kind==='result'&&v.artifactIds.some(key=>!state.queued.has('artifact:'+key)))fail('result_artifact_missing');if(value.kind==='result'&&!(state.phase==='process_exited'||state.phase==='blocked'&&v.disposition==='blocked'))fail('result_phase_unverified');
  state.queued.set(key,value);
 }
}
function decode(text,owner,maxRecords){
 if(text&&!text.endsWith('\n'))fail('journal_truncated_reconcile_required');const state=initial(owner);
 for(const line of text.split('\n').filter(Boolean)){
  const row=JSON.parse(line);shape(row,['schemaVersion','identity','sequence','previousSha256','entry','sha256']);if(row.schemaVersion!==1||canonical(identity(row.identity))!==canonical(owner)||row.sequence!==state.records.length+1||row.previousSha256!==(state.records.at(-1)?.sha256??null))fail('journal_corrupt');digest(row.sha256);const parsed=entry(row.entry,owner),body={schemaVersion:1,identity:owner,sequence:row.sequence,previousSha256:row.previousSha256,entry:parsed};if(sha(body)!==row.sha256)fail('journal_digest_differs');apply(state,parsed);state.records.push(row);if(state.records.length>maxRecords)fail('journal_capacity');
 }return state;
}
async function directorySafe(directory,{create=false,verifyPrivateState}={}){
 if(typeof directory!=='string'||!isAbsolute(directory)||directory.startsWith('\\\\')||directory.startsWith('//'))fail('unsafe_journal_directory');
 let parent=dirname(directory);for(;;){const stat=await lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe_journal_parent');if(parent===parsePath(parent).root)break;parent=dirname(parent);}
 if(create)await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)fail('unsafe_journal_directory');
 if(process.platform==='win32'){if(typeof verifyPrivateState!=='function')fail('windows_private_acl_unverified');await verifyPrivateState(directory);}else if((stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid())fail('journal_permissions_unsafe');
}
async function syncDirectory(directory){if(process.platform==='win32')return;const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
function limits(options){return {maxBytes:integer(options.maxBytes??JOURNAL_LIMITS.bytes,1,JOURNAL_LIMITS.bytes),maxRecords:integer(options.maxRecords??JOURNAL_LIMITS.records,1,JOURNAL_LIMITS.records)};}
async function readHandle(handle,owner,bound){const stat=await handle.stat();if(!stat.isFile()||stat.size>bound.maxBytes)fail('journal_capacity');const text=new TextDecoder('utf-8',{fatal:true}).decode(await handle.readFile());if(Buffer.byteLength(text)>bound.maxBytes)fail('journal_capacity');return {state:decode(text,owner,bound.maxRecords),size:Buffer.byteLength(text)};}
export async function inspectExecutionJournal({directory,identity:rawIdentity,...options}){const owner=identity(rawIdentity),bound=limits(options);await directorySafe(directory,options);const handle=await open(join(directory,'journal.ndjson'),constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const {state,size}=await readHandle(handle,owner,bound);return snapshot(state,size);}finally{await handle.close();}}
function snapshot(state,size){return {identity:{...state.identity},phase:state.phase,workspaceKey:state.workspaceKey,processIdentity:state.processIdentity===null?null:{...state.processIdentity},nextEventSequence:state.nextEventSequence,records:JSON.parse(canonical(state.records)),pending:[...state.queued].filter(([key])=>!state.receipts.has(key)).map(([key,value])=>({key,sha256:sha(value.value),entry:JSON.parse(canonical(value))})),bytes:size};}
/** Exclusive append-only journal. Torn writes refuse recovery; no truncation,
 * cap pruning, stale-lock takeover or telemetry-outbox eviction exists. */
export async function openExecutionJournal({directory,identity:rawIdentity,...options}){
 const owner=identity(rawIdentity),bound=limits(options);await directorySafe(directory,{...options,create:true});const lockPath=join(directory,'writer.lock'),nonce=randomUUID();let lock;try{lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('journal_locked_reconcile_required');throw error;}
 let handle,closed=false,poisoned=false;
 try{await lock.writeFile(nonce);await lock.sync();await syncDirectory(directory);handle=await open(join(directory,'journal.ndjson'),constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600);let {state,size}=await readHandle(handle,owner,bound);await syncDirectory(directory);let serial=Promise.resolve();
  async function append(raw){
   if(closed||poisoned)fail('journal_closed_or_uncertain');const parsed=entry(raw,owner),key=parsed.kind==='event'?'event:'+parsed.value.sequence:parsed.kind==='artifact'?'artifact:'+parsed.value.id:parsed.kind==='result'?'result:'+owner.attemptId:null;
   if(key&&state.queued.has(key)){if(canonical(state.queued.get(key))!==canonical(parsed))fail('duplicate_journal_identity');return snapshot(state,size);}
   if(parsed.kind==='receipt'){const key=parsed.value.target+':'+parsed.value.id;if(state.receipts.has(key)){if(canonical(state.receipts.get(key))!==canonical(parsed.value))fail('receipt_identity_differs');return snapshot(state,size);}}
   const next={...state,records:[...state.records],queued:new Map(state.queued),receipts:new Map(state.receipts)};apply(next,parsed);
   const body={schemaVersion:1,identity:owner,sequence:state.records.length+1,previousSha256:state.records.at(-1)?.sha256??null,entry:parsed},row={...body,sha256:sha(body)},line=canonical(row)+'\n',length=Buffer.byteLength(line);
   if(size+length>bound.maxBytes||state.records.length+1>bound.maxRecords)fail('journal_capacity');
   try{await handle.writeFile(line);await handle.sync();}catch{poisoned=true;fail('journal_write_uncertain');}next.records.push(row);state=next;size+=length;return snapshot(state,size);
  }
  return Object.freeze({snapshot:()=>snapshot(state,size),append(raw){const result=serial.then(()=>append(raw));serial=result.catch(()=>{});return result;},async close(){await serial;if(closed)return;closed=true;await handle.close();await lock.close();const check=await open(lockPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let value;try{value=await check.readFile('utf8');}finally{await check.close();}if(value!==nonce)fail('journal_lock_identity_differs');await unlink(lockPath);await syncDirectory(directory);}});
 }catch(error){await handle?.close().catch(()=>{});await lock?.close().catch(()=>{});await unlink(lockPath).catch(()=>{});throw error instanceof ExecutorError?error:new ExecutorError('journal_open_failed');}
}

export async function verifyExecutionDirectory(directory,options={}){await directorySafe(directory,options);}
