import {validateLocalAnalysis} from './local-analysis.mjs';
import {validateProjectBriefing,validateCompactPlan,validateProjectFraming,BRIEFING_MODELS} from './project-briefing.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,KEY=/^[A-Za-z0-9_-]{1,128}$/u,HASH=/^[a-f0-9]{64}$/u,HEAD=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const statuses=['queued','claimed','completed','failed','cancelled'],providers=['codex','claude'],kinds=['browse','analyze','brief'];
/** briefMs bounds one claimed briefing (fetch, chats and one model call); policies are per repository. */
export const PERSONAL_LIMITS=Object.freeze({repositories:16,claimMs:300000,briefMs:600000,queueMs:600000,bodyBytes:65536,stateBytes:500000,policies:16,minIntervalMinutes:30,maxIntervalMinutes:1440,defaultIntervalMinutes:120});
const requestKeys=['id','kind','status','createdAt','expiresAt','claimedAt','projectId','repositoryKey','provider','requestedModel','report','reportSha256','error','consumedAt','origin','plan','framing','briefing','fingerprint'];
const briefOnly=['origin','plan','framing','briefing','fingerprint'];
function fail(){throw new Error('Personal repository request is invalid.');}
function obj(v,keys,required=keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(v,k)))fail();return v;}
function text(v,max,pattern){if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/u.test(v)||pattern&&!pattern.test(v))fail();return v;}
function stamp(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)||!Number.isFinite(Date.parse(v)))fail();return v;}
function bool(v){if(typeof v!=='boolean')fail();return v;}
const modelFor=provider=>BRIEFING_MODELS[provider];
export function parseProviders(v){obj(v,['codex','claude']);for(const p of Object.values(v)){obj(p,['ready','detail']);bool(p.ready);if(!['ready','not_installed','auth_required','unavailable'].includes(p.detail))fail();}return structuredClone(v);}
export function parseRepositories(v){if(!Array.isArray(v)||v.length>16)fail();for(const r of v){obj(r,['key','name','head','dirty','hasPreviousAnalysis']);text(r.key,128,KEY);text(r.name,100);if(/[\\/:]/u.test(r.name))fail();text(r.head,64,HEAD);bool(r.dirty);bool(r.hasPreviousAnalysis);}if(new Set(v.map(r=>r.key)).size!==v.length)fail();return structuredClone(v);}
function parsePolicy(v){
 obj(v,['repositoryKey','projectId','provider','enabled','minIntervalMinutes','updatedAt','lastBriefAt','lastAttemptAt','lastFingerprint']);
 text(v.repositoryKey,128,KEY);text(v.projectId,128,ID);if(!providers.includes(v.provider))fail();bool(v.enabled);
 if(!Number.isSafeInteger(v.minIntervalMinutes)||v.minIntervalMinutes<PERSONAL_LIMITS.minIntervalMinutes||v.minIntervalMinutes>PERSONAL_LIMITS.maxIntervalMinutes)fail();
 stamp(v.updatedAt);if(v.lastBriefAt!==null)stamp(v.lastBriefAt);if(v.lastAttemptAt!==null)stamp(v.lastAttemptAt);if(v.lastFingerprint!==null)text(v.lastFingerprint,64,HASH);
 return v;
}
export function parsePolicies(v){if(!Array.isArray(v)||v.length>PERSONAL_LIMITS.policies)fail();for(const p of v)parsePolicy(p);if(new Set(v.map(p=>p.repositoryKey)).size!==v.length)fail();return structuredClone(v);}
export function parseOwnerAction(v){
 obj(v,['action','requestId','projectId','repositoryKey','provider','runId','reportSha256','enabled','minIntervalMinutes'],['action']);
 const shapes={browse:['action','requestId'],analyze:['action','requestId','projectId','repositoryKey','provider'],brief:['action','requestId','projectId','repositoryKey','provider'],cancel:['action','requestId'],disconnect:['action'],connect:['action'],'clear-finished':['action'],ack:['action','requestId','runId','reportSha256'],'keep-current':['action','repositoryKey','projectId','provider','enabled','minIntervalMinutes']};
 const keys=shapes[v.action];if(!keys)fail();
 obj(v,keys,v.action==='keep-current'?keys.filter(k=>k!=='minIntervalMinutes'):keys);
 if(Object.hasOwn(v,'requestId'))text(v.requestId,36,UUID);if(Object.hasOwn(v,'projectId'))text(v.projectId,128,ID);if(Object.hasOwn(v,'repositoryKey'))text(v.repositoryKey,128,KEY);
 if(Object.hasOwn(v,'provider')&&!providers.includes(v.provider))fail();if(Object.hasOwn(v,'runId'))text(v.runId,36,UUID);if(Object.hasOwn(v,'reportSha256'))text(v.reportSha256,64,HASH);
 if(Object.hasOwn(v,'enabled'))bool(v.enabled);
 if(Object.hasOwn(v,'minIntervalMinutes')&&(!Number.isSafeInteger(v.minIntervalMinutes)||v.minIntervalMinutes<PERSONAL_LIMITS.minIntervalMinutes||v.minIntervalMinutes>PERSONAL_LIMITS.maxIntervalMinutes))fail();
 return structuredClone(v);
}
export function parseDeviceAction(v){
 obj(v,['action','requestId','repositoryKey','providers','repositories','report','briefing','fingerprint','error'],['action']);
 const shapes={poll:['action','providers','repositories'],complete:['action','requestId','repositories','report','briefing','fingerprint'],fail:['action','requestId','error'],'auto-brief':['action','requestId','repositoryKey','fingerprint']};
 const keys=shapes[v.action];if(!keys)fail();
 obj(v,keys,v.action==='poll'?['action']:v.action==='complete'?['action','requestId']:keys);
 if(Object.hasOwn(v,'requestId'))text(v.requestId,36,UUID);if(Object.hasOwn(v,'repositoryKey'))text(v.repositoryKey,128,KEY);
 if(Object.hasOwn(v,'providers'))parseProviders(v.providers);if(Object.hasOwn(v,'repositories'))parseRepositories(v.repositories);
 if(Object.hasOwn(v,'report'))validateLocalAnalysis(v.report);if(Object.hasOwn(v,'briefing'))validateProjectBriefing(v.briefing);
 if(Object.hasOwn(v,'fingerprint'))text(v.fingerprint,64,HASH);
 if(v.action==='complete'&&Object.hasOwn(v,'report')&&Object.hasOwn(v,'briefing'))fail();
 if(Object.hasOwn(v,'error')&&!['cancelled','folder_unavailable','provider_unavailable','analysis_failed','interrupted'].includes(v.error))fail();
 return structuredClone(v);
}
export function initialPersonalState(deviceId){text(deviceId,128,ID);return {version:1,deviceId,connected:true,epoch:0,lastSeenAt:null,providers:{codex:{ready:false,detail:'unavailable'},claude:{ready:false,detail:'unavailable'}},repositories:[],requests:[],policies:[]};}
/** New reports must describe the exact immutable framing admitted by the server.
 * Historical plan jobs retain their original validation and serialized bytes. */
function matchBriefingFraming(job,rawBriefing,briefing){
 if(!Object.hasOwn(job,'framing'))return;
 const framing=validateProjectFraming(job.framing),coverage=briefing.evidence.framing;
 if(rawBriefing.version!==3||!coverage||briefing.project.name!==framing.projectName)fail();
 const expected={workspaceRevision:framing.workspaceRevision,characters:framing.framing.length,includeTaskPlan:framing.includeTaskPlan,totalMilestones:framing.totalMilestones,totalTasks:framing.totalTasks,includedMilestones:framing.milestones.length,includedTasks:framing.tasks.length};
 if(Object.entries(expected).some(([key,value])=>coverage[key]!==value))fail();
}
function validateRequest(j){
 obj(j,requestKeys,['id','kind','status','createdAt','expiresAt','claimedAt']);
 text(j.id,36,UUID);if(!kinds.includes(j.kind)||!statuses.includes(j.status))fail();stamp(j.createdAt);stamp(j.expiresAt);if(j.claimedAt!==null)stamp(j.claimedAt);
 const model=j.kind==='browse'?[]:['projectId','repositoryKey','provider','requestedModel'];
 if(j.kind==='browse'&&['projectId','repositoryKey','provider','requestedModel','report','briefing','reportSha256','consumedAt','plan','framing','origin','fingerprint'].some(k=>Object.hasOwn(j,k)))fail();
 if(model.length){text(j.projectId,128,ID);text(j.repositoryKey,128,KEY);if(!providers.includes(j.provider)||j.requestedModel!==modelFor(j.provider))fail();}
 if(j.kind==='analyze'){
  if(briefOnly.some(k=>Object.hasOwn(j,k)))fail();
  if(Object.hasOwn(j,'report')){validateLocalAnalysis(j.report);text(j.reportSha256,64,HASH);if(j.status!=='completed'||j.report.run.id!==j.id||j.report.repository.key!==j.repositoryKey||j.report.run.provider!==j.provider||j.report.run.requestedModel!==j.requestedModel||j.report.run.source!=='personal-pc-connector')fail();}
  else if(j.reportSha256||j.consumedAt||j.status==='completed')fail();
 }
 if(j.kind==='brief'){
  if(Object.hasOwn(j,'report')||!['owner','auto'].includes(j.origin))fail();
  // Legacy plans remain unchanged so historical state and export digests stay verifiable.
  if(Object.hasOwn(j,'framing')){if(Object.hasOwn(j,'plan')||validateProjectFraming(j.framing).projectId!==j.projectId)fail();}
  else if(validateCompactPlan(j.plan).project.id!==j.projectId)fail();
  if(Object.hasOwn(j,'fingerprint'))text(j.fingerprint,64,HASH);
  if(Object.hasOwn(j,'briefing')){const b=validateProjectBriefing(j.briefing);text(j.reportSha256,64,HASH);if(j.status!=='completed'||b.run.id!==j.id||b.repository.key!==j.repositoryKey||b.run.provider!==j.provider||b.run.requestedModel!==j.requestedModel||b.run.origin!==j.origin||b.project.id!==j.projectId)fail();matchBriefingFraming(j,j.briefing,b);}
  else if(j.reportSha256||j.consumedAt||j.status==='completed')fail();
 }
 if(j.consumedAt)stamp(j.consumedAt);
 if(j.error&&!['deadline_exceeded','cancelled','folder_unavailable','provider_unavailable','analysis_failed','interrupted','disconnected'].includes(j.error))fail();
}
export function validatePersonalState(v){
 obj(v,['version','deviceId','connected','epoch','lastSeenAt','providers','repositories','requests','policies'],['version','deviceId','connected','epoch','lastSeenAt','providers','repositories','requests']);
 if(v.version!==1||!Number.isSafeInteger(v.epoch)||v.epoch<0)fail();text(v.deviceId,128,ID);bool(v.connected);if(v.lastSeenAt!==null)stamp(v.lastSeenAt);parseProviders(v.providers);parseRepositories(v.repositories);
 if(!Array.isArray(v.requests))fail();for(const j of v.requests)validateRequest(j);
 if(new Set(v.requests.map(j=>j.id)).size!==v.requests.length)fail();
 if(Object.hasOwn(v,'policies'))parsePolicies(v.policies);
 if(new TextEncoder().encode(JSON.stringify(v)).byteLength>PERSONAL_LIMITS.stateBytes)fail();
 return structuredClone(v);
}
/** Only the server supplies framing from the owner's workspace at admission. */
function requireProjectFraming(context,projectId){const framing=context?.framing;if(!framing)fail();const checked=validateProjectFraming(framing);if(checked.projectId!==projectId)fail();return checked;}
const hasResult=j=>Boolean(j.report||j.briefing);
/** Queue history has no request-count cap. Repeated claims never repeat a model call; delivery retries are handled by the store. */
export function transitionPersonalState(raw,action,now,actor,context={}){
  const s=validatePersonalState(raw);if(!Object.hasOwn(s,'policies'))s.policies=[];stamp(now);const a=actor==='owner'?parseOwnerAction(action):parseDeviceAction(action);
 for(const j of s.requests)if(['queued','claimed'].includes(j.status)){if(j.kind==='brief'&&!j.framing){j.status='failed';j.error='interrupted';}else if(Date.parse(j.expiresAt)<=Date.parse(now)){j.status='failed';j.error='deadline_exceeded';}}
 const claimWindow=kind=>new Date(Date.parse(now)+(kind==='brief'?PERSONAL_LIMITS.briefMs:PERSONAL_LIMITS.claimMs)).toISOString();
 if(actor==='owner'){
  if(a.action==='clear-finished'){s.requests=s.requests.filter(j=>['queued','claimed'].includes(j.status)||j.status==='completed'&&hasResult(j)&&!j.consumedAt);return s;}
  if(a.action==='connect'){if(!s.connected){s.connected=true;s.epoch++;}return s;}
  if(a.action==='disconnect'){s.connected=false;s.epoch++;for(const j of s.requests)if(['queued','claimed'].includes(j.status)){j.status='cancelled';j.error='disconnected';}return s;}
  if(a.action==='keep-current'){
   if(!s.repositories.some(r=>r.key===a.repositoryKey))fail();
   const existing=s.policies.find(p=>p.repositoryKey===a.repositoryKey);
   const next={repositoryKey:a.repositoryKey,projectId:a.projectId,provider:a.provider,enabled:a.enabled,minIntervalMinutes:a.minIntervalMinutes??existing?.minIntervalMinutes??PERSONAL_LIMITS.defaultIntervalMinutes,updatedAt:now,lastBriefAt:existing?.lastBriefAt??null,lastAttemptAt:existing?.lastAttemptAt??null,lastFingerprint:existing?.lastFingerprint??null};
   if(existing){const same=['repositoryKey','projectId','provider','enabled','minIntervalMinutes'].every(k=>existing[k]===next[k]);if(same)return s;Object.assign(existing,next);}
   else{if(s.policies.length>=PERSONAL_LIMITS.policies)throw new Error('Too many repositories keep a briefing current. Switch one off first.');s.policies.push(next);}
   return s;
  }
  const job=s.requests.find(j=>j.id===a.requestId);
  if(a.action==='cancel'){if(!job)fail();if(['queued','claimed'].includes(job.status)){job.status='cancelled';job.error='cancelled';}return s;}
  if(a.action==='ack'){const result=job?.report??job?.briefing;if(!job||job.status!=='completed'||!result||result.run.id!==a.runId||job.reportSha256!==a.reportSha256)fail();job.consumedAt??=now;return s;}
  if(!s.connected)fail();
  if(job){if(job.kind!==a.action||a.action!=='browse'&&(job.projectId!==a.projectId||job.repositoryKey!==a.repositoryKey||job.provider!==a.provider))fail();return s;}
  if(a.action!=='browse'&&!s.repositories.some(r=>r.key===a.repositoryKey))fail();
  const framing=a.action==='brief'?requireProjectFraming(context,a.projectId):null;
  s.requests.push({id:a.requestId,kind:a.action,status:'queued',createdAt:now,expiresAt:new Date(Date.parse(now)+PERSONAL_LIMITS.queueMs).toISOString(),claimedAt:null,...(a.action==='browse'?{}:{projectId:a.projectId,repositoryKey:a.repositoryKey,provider:a.provider,requestedModel:modelFor(a.provider)}),...(a.action==='brief'?{origin:'owner',framing}:{})});
  return s;
 }
 if(!['poll','auto-brief'].includes(a.action)){const terminal=s.requests.find(j=>j.id===a.requestId);if(terminal&&['failed','cancelled'].includes(terminal.status))return s;}
 if(!s.connected){if(a.action==='poll')return s;throw new Error('Personal PC is disconnected.');}
 if(a.action!=='poll')s.lastSeenAt=now;if(a.providers)s.providers=parseProviders(a.providers);
 if(a.action==='poll'){if(a.repositories)s.repositories=parseRepositories(a.repositories);if(!s.requests.some(j=>j.status==='claimed')){const j=s.requests.find(j=>j.status==='queued');if(j){j.status='claimed';j.claimedAt=now;j.expiresAt=claimWindow(j.kind);}}return s;}
 if(a.action==='auto-brief'){
  const existing=s.requests.find(j=>j.id===a.requestId);if(existing){if(existing.kind!=='brief'||existing.origin!=='auto'||existing.repositoryKey!==a.repositoryKey)fail();return s;}
  const policy=s.policies.find(p=>p.repositoryKey===a.repositoryKey&&p.enabled);
  if(!policy||!s.repositories.some(r=>r.key===a.repositoryKey)||s.requests.some(j=>['queued','claimed'].includes(j.status)))throw new Error('Automatic briefing is not admitted right now.');
  const interval=policy.minIntervalMinutes*60000,recent=time=>time!==null&&Date.parse(now)-Date.parse(time)<interval;
  if(recent(policy.lastBriefAt)||recent(policy.lastAttemptAt)||policy.lastFingerprint===a.fingerprint)throw new Error('Automatic briefing is not due.');
  const framing=requireProjectFraming(context,policy.projectId);
  policy.lastAttemptAt=now;
  s.requests.push({id:a.requestId,kind:'brief',status:'claimed',createdAt:now,expiresAt:claimWindow('brief'),claimedAt:now,projectId:policy.projectId,repositoryKey:a.repositoryKey,provider:policy.provider,requestedModel:modelFor(policy.provider),origin:'auto',framing,fingerprint:a.fingerprint});
  return s;
 }
 const job=s.requests.find(j=>j.id===a.requestId);if(!job||job.status!=='claimed')fail();
 if(a.action==='fail'){job.status='failed';job.error=a.error;return s;}
 if(job.kind==='browse'){if(!a.repositories||a.report||a.briefing||a.fingerprint)fail();s.repositories=parseRepositories(a.repositories);}
 else if(job.kind==='analyze'){
  if(!a.report||a.repositories||a.briefing||a.fingerprint||a.report.run.id!==job.id||a.report.repository.key!==job.repositoryKey||a.report.run.provider!==job.provider||a.report.run.requestedModel!==job.requestedModel||a.report.run.source!=='personal-pc-connector')fail();
  job.report=validateLocalAnalysis(a.report);const repository=s.repositories.find(r=>r.key===job.repositoryKey);if(repository){repository.head=a.report.repository.head;repository.dirty=a.report.repository.dirty;repository.hasPreviousAnalysis=true;}
 }else{
  const b=a.briefing;
  if(!b||a.report||a.repositories||b.run.id!==job.id||b.repository.key!==job.repositoryKey||b.run.provider!==job.provider||b.run.requestedModel!==job.requestedModel||b.run.source!=='personal-pc-connector'||b.run.origin!==job.origin||b.project.id!==job.projectId)fail();
  const briefing=validateProjectBriefing(b);matchBriefingFraming(job,b,briefing);job.briefing=briefing;if(a.fingerprint)job.fingerprint=a.fingerprint;
  const repository=s.repositories.find(r=>r.key===job.repositoryKey);if(repository){repository.head=b.repository.head;repository.dirty=b.repository.dirty;}
  const policy=s.policies.find(p=>p.repositoryKey===job.repositoryKey);if(policy){policy.lastBriefAt=now;if(job.fingerprint)policy.lastFingerprint=job.fingerprint;}
 }
 job.status='completed';return s;
}
