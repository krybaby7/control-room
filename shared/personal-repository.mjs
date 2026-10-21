import {validateLocalAnalysis} from './local-analysis.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,KEY=/^[A-Za-z0-9_-]{1,128}$/u,HASH=/^[a-f0-9]{64}$/u,HEAD=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const statuses=['queued','claimed','completed','failed','cancelled'];
export const PERSONAL_LIMITS=Object.freeze({repositories:16,jobs:20,claimMs:300000,queueMs:600000,bodyBytes:65536,stateBytes:500000});
function fail(){throw new Error('Personal repository request is invalid.');}
function obj(v,keys,required=keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(v,k)))fail();return v;}
function text(v,max,pattern){if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/u.test(v)||pattern&&!pattern.test(v))fail();return v;}
function stamp(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)||!Number.isFinite(Date.parse(v)))fail();return v;}
function bool(v){if(typeof v!=='boolean')fail();return v;}
export function parseProviders(v){obj(v,['codex','claude']);for(const p of Object.values(v)){obj(p,['ready','detail']);bool(p.ready);if(!['ready','not_installed','auth_required','unavailable'].includes(p.detail))fail();}return structuredClone(v);}
export function parseRepositories(v){if(!Array.isArray(v)||v.length>16)fail();for(const r of v){obj(r,['key','name','head','dirty','hasPreviousAnalysis']);text(r.key,128,KEY);text(r.name,100);if(/[\\/:]/u.test(r.name))fail();text(r.head,64,HEAD);bool(r.dirty);bool(r.hasPreviousAnalysis);}if(new Set(v.map(r=>r.key)).size!==v.length)fail();return structuredClone(v);}
export function parseOwnerAction(v){obj(v,['action','requestId','projectId','repositoryKey','provider','runId','reportSha256'],['action']);const keys={browse:['action','requestId'],analyze:['action','requestId','projectId','repositoryKey','provider'],cancel:['action','requestId'],disconnect:['action'],connect:['action'],'clear-finished':['action'],ack:['action','requestId','runId','reportSha256']}[v.action];if(!keys)fail();obj(v,keys);if(Object.hasOwn(v,"requestId"))text(v.requestId,36,UUID);if(Object.hasOwn(v,"projectId"))text(v.projectId,128,ID);if(Object.hasOwn(v,"repositoryKey"))text(v.repositoryKey,128,KEY);if(Object.hasOwn(v,'provider')&&!['codex','claude'].includes(v.provider))fail();if(Object.hasOwn(v,"runId"))text(v.runId,36,UUID);if(Object.hasOwn(v,"reportSha256"))text(v.reportSha256,64,HASH);return structuredClone(v);}
export function parseDeviceAction(v){obj(v,['action','requestId','providers','repositories','report','error'],['action']);const keys={poll:['action','providers','repositories'],complete:['action','requestId','repositories','report'],fail:['action','requestId','error']}[v.action];if(!keys)fail();obj(v,keys,v.action==='poll'?['action']:v.action==='complete'?['action','requestId']:keys);if(Object.hasOwn(v,"requestId"))text(v.requestId,36,UUID);if(Object.hasOwn(v,"providers"))parseProviders(v.providers);if(Object.hasOwn(v,"repositories"))parseRepositories(v.repositories);if(Object.hasOwn(v,"report"))validateLocalAnalysis(v.report);if(Object.hasOwn(v,'error')&&!['cancelled','folder_unavailable','provider_unavailable','analysis_failed','interrupted'].includes(v.error))fail();return structuredClone(v);}
export function initialPersonalState(deviceId){text(deviceId,128,ID);return {version:1,deviceId,connected:true,epoch:0,lastSeenAt:null,providers:{codex:{ready:false,detail:'unavailable'},claude:{ready:false,detail:'unavailable'}},repositories:[],requests:[]};}
export function validatePersonalState(v){obj(v,['version','deviceId','connected','epoch','lastSeenAt','providers','repositories','requests']);if(v.version!==1||!Number.isSafeInteger(v.epoch)||v.epoch<0)fail();text(v.deviceId,128,ID);bool(v.connected);if(v.lastSeenAt!==null)stamp(v.lastSeenAt);parseProviders(v.providers);parseRepositories(v.repositories);if(!Array.isArray(v.requests)||v.requests.length>20)fail();for(const j of v.requests){obj(j,['id','kind','status','createdAt','expiresAt','claimedAt','projectId','repositoryKey','provider','requestedModel','report','reportSha256','error','consumedAt'],['id','kind','status','createdAt','expiresAt','claimedAt']);text(j.id,36,UUID);if(!['browse','analyze'].includes(j.kind)||!statuses.includes(j.status))fail();stamp(j.createdAt);stamp(j.expiresAt);if(j.claimedAt!==null)stamp(j.claimedAt);if(j.kind==='analyze'){text(j.projectId,128,ID);text(j.repositoryKey,128,KEY);if(!['codex','claude'].includes(j.provider)||j.requestedModel!==(j.provider==='codex'?'gpt-6.1-sol':'claude-code-default'))fail();}else if(['projectId','repositoryKey','provider','requestedModel','report','reportSha256','consumedAt'].some(k=>Object.hasOwn(j,k)))fail();if(Object.hasOwn(j,'report')){validateLocalAnalysis(j.report);text(j.reportSha256,64,HASH);if(j.kind!=='analyze'||j.status!=='completed'||j.report.run.id!==j.id||j.report.repository.key!==j.repositoryKey||j.report.run.provider!==j.provider||j.report.run.requestedModel!==j.requestedModel||j.report.run.source!=='personal-pc-connector')fail();}else if(j.reportSha256||j.consumedAt||j.kind==='analyze'&&j.status==='completed')fail();if(j.consumedAt)stamp(j.consumedAt);if(j.error&&!['deadline_exceeded','cancelled','folder_unavailable','provider_unavailable','analysis_failed','interrupted','disconnected'].includes(j.error))fail();}if(new Set(v.requests.map(j=>j.id)).size!==v.requests.length||new TextEncoder().encode(JSON.stringify(v)).byteLength>PERSONAL_LIMITS.stateBytes)fail();return structuredClone(v);}
/** Pure finite queue. Repeated claims never repeat a model call; delivery retries are handled by the store. */
export function transitionPersonalState(raw,action,now,actor){const s=validatePersonalState(raw);stamp(now);const a=actor==='owner'?parseOwnerAction(action):parseDeviceAction(action);for(const j of s.requests)if(['queued','claimed'].includes(j.status)&&Date.parse(j.expiresAt)<=Date.parse(now)){j.status='failed';j.error='deadline_exceeded';}
 if(actor==='owner'){
 if(a.action==='clear-finished'){s.requests=s.requests.filter(j=>['queued','claimed'].includes(j.status)||j.status==='completed'&&j.report&&!j.consumedAt);return s;}
 if(a.action==='connect'){if(!s.connected){s.connected=true;s.epoch++;}return s;}
 if(a.action==='disconnect'){s.connected=false;s.epoch++;for(const j of s.requests)if(['queued','claimed'].includes(j.status)){j.status='cancelled';j.error='disconnected';}return s;}
 const job=s.requests.find(j=>j.id===a.requestId);
 if(a.action==='cancel'){if(!job)fail();if(['queued','claimed'].includes(job.status)){job.status='cancelled';job.error='cancelled';}return s;}
 if(a.action==='ack'){if(!job||job.status!=='completed'||!job.report||job.report.run.id!==a.runId||job.reportSha256!==a.reportSha256)fail();job.consumedAt??=now;return s;}
 if(!s.connected)fail();
 if(job){if(job.kind!==a.action||a.action==='analyze'&&(job.projectId!==a.projectId||job.repositoryKey!==a.repositoryKey||job.provider!==a.provider))fail();return s;}
 if(s.requests.length>=20)throw new Error('Recent connection requests are full. Clear finished requests to continue.');
 if(a.action==='analyze'&&!s.repositories.some(r=>r.key===a.repositoryKey))fail();
 s.requests.push({id:a.requestId,kind:a.action,status:'queued',createdAt:now,expiresAt:new Date(Date.parse(now)+PERSONAL_LIMITS.queueMs).toISOString(),claimedAt:null,...(a.action==='analyze'?{projectId:a.projectId,repositoryKey:a.repositoryKey,provider:a.provider,requestedModel:a.provider==='codex'?'gpt-6.1-sol':'claude-code-default'}:{})});return s;
 }
 if(a.action!=='poll'){const terminal=s.requests.find(j=>j.id===a.requestId);if(terminal&&['failed','cancelled'].includes(terminal.status))return s;}if(!s.connected){if(a.action==='poll')return s;throw new Error('Personal PC is disconnected.');}s.lastSeenAt=now;if(a.providers)s.providers=parseProviders(a.providers);
 if(a.action==='poll'){if(a.repositories)s.repositories=parseRepositories(a.repositories);if(!s.requests.some(j=>j.status==='claimed')){const j=s.requests.find(j=>j.status==='queued');if(j){j.status='claimed';j.claimedAt=now;j.expiresAt=new Date(Date.parse(now)+PERSONAL_LIMITS.claimMs).toISOString();}}return s;}
 const job=s.requests.find(j=>j.id===a.requestId);if(!job||job.status!=='claimed')fail();
 if(a.action==='fail'){job.status='failed';job.error=a.error;return s;}
 if(job.kind==='browse'){if(!a.repositories||a.report)fail();s.repositories=parseRepositories(a.repositories);}else{if(!a.report||a.repositories||a.report.run.id!==job.id||a.report.repository.key!==job.repositoryKey||a.report.run.provider!==job.provider||a.report.run.requestedModel!==job.requestedModel||a.report.run.source!=='personal-pc-connector')fail();job.report=validateLocalAnalysis(a.report);const repository=s.repositories.find(r=>r.key===job.repositoryKey);if(repository){repository.head=a.report.repository.head;repository.dirty=a.report.repository.dirty;repository.hasPreviousAnalysis=true;}}
 job.status='completed';return s;
}








