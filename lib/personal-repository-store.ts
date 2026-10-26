import {initialPersonalState,parseOwnerAction,parseDeviceAction,transitionPersonalState,validatePersonalState,type PersonalState,type PersonalOwnerAction,type PersonalJob} from '../shared/personal-repository.mjs';
import {projectFraming,validateProjectBriefing,PROJECT_BRIEFING_MARKER,type ProjectFraming} from '../shared/project-briefing.mjs';
import {canonical,contentHash} from './canonical-json.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {readCurrent} from './workspace-store.ts';
import {RequestError} from './api-guards.ts';
import {LOCAL_ANALYSIS_MARKER} from './local-analysis-handler.ts';
import {validateLocalAnalysis} from '../shared/local-analysis.mjs';
import {evidenceLinkSchema,evidenceVersionSchema} from './evidence-validation.ts';
/** Only a pure refusal before any mutation attempt can release a retained UI intent. */
export class PersonalRequestRejectedError extends RequestError {}
export interface PersonalConnectorConfiguration {version:1;ownerId:string;deviceId:string;keyHash:string;siteOrigin:string}
export function parsePersonalConfiguration(raw:unknown):PersonalConnectorConfiguration|null{try{if(typeof raw!=='string'||raw.length>2048)return null;const v=JSON.parse(raw);if(!v||Object.keys(v).sort().join(',')!=='deviceId,keyHash,ownerId,siteOrigin,version'||v.version!==1||typeof v.ownerId!=='string'||!v.ownerId||v.ownerId.length>256||typeof v.deviceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v.deviceId)||typeof v.keyHash!=='string'||!/^[a-f0-9]{64}$/u.test(v.keyHash))return null;const u=new URL(v.siteOrigin);if(u.protocol!=='https:'||u.origin!==v.siteOrigin||u.username||u.password)return null;return v;}catch{return null;}}
interface StateRow {row_revision:number;payload_json:string;content_hash:string;last_seen_at:string|null}
async function current(db:SqlDatabase,c:PersonalConnectorConfiguration):Promise<{state:PersonalState;row:StateRow|null}>{const row=await db.prepare('SELECT row_revision,payload_json,content_hash,last_seen_at FROM personal_repository_state WHERE user_id=? AND id=? AND archived_at IS NULL').bind(c.ownerId,c.deviceId).first<StateRow>();if(!row)return{state:initialPersonalState(c.deviceId),row:null};const state=validatePersonalState(JSON.parse(row.payload_json));if(state.deviceId!==c.deviceId||await contentHash(canonical(state))!==row.content_hash)throw new RequestError('Personal PC state could not be verified.',409);return{state,row};}
/** Owner projection: results are exposed once as `completedReport`/`completedBriefing`; framing and bodies never ride along in the job list. */
export async function personalOwnerView(db:SqlDatabase,c:PersonalConnectorConfiguration,now:string){
 const {state,row}=await current(db,c);const lastSeenAt=row?.last_seen_at??state.lastSeenAt;
 const completed=state.requests.find(j=>j.kind==='analyze'&&j.status==='completed'&&j.report&&!j.consumedAt);
 const briefed=state.requests.find(j=>j.kind==='brief'&&j.status==='completed'&&j.briefing&&!j.consumedAt);
 return {configured:true,deviceId:c.deviceId,connected:state.connected,online:state.connected&&lastSeenAt!==null&&Date.parse(now)-Date.parse(lastSeenAt)<20000,lastSeenAt,providers:state.providers,repositories:state.repositories,
  jobs:state.requests.map(({report,briefing,plan,framing,...job})=>{void report;void briefing;void plan;void framing;return job;}),
  policies:(state.policies??[]).map(({lastFingerprint,...policy})=>{void lastFingerprint;return policy;}),
  completedReport:completed?{requestId:completed.id,projectId:completed.projectId!,report:completed.report!,reportSha256:completed.reportSha256!}:null,
  completedBriefing:briefed?{requestId:briefed.id,projectId:briefed.projectId!,briefing:briefed.briefing!,briefingSha256:briefed.reportSha256!}:null};
}
async function savedResultMatches(db:SqlDatabase,owner:string,a:Extract<PersonalOwnerAction,{action:'ack'}>,s:PersonalState){
 const j=s.requests.find(j=>j.id===a.requestId);const result=j?.report??j?.briefing;if(!j?.projectId||!result||result.run.id!==a.runId||j.reportSha256!==a.reportSha256)return false;
 const marker=j.kind==='brief'?PROJECT_BRIEFING_MARKER:LOCAL_ANALYSIS_MARKER,validate=j.kind==='brief'?validateProjectBriefing:validateLocalAnalysis;
 const versions=(await db.prepare('SELECT payload_json FROM evidence_versions WHERE user_id=? AND json_extract(payload_json,\'$.sourceRecordId\')=? AND json_extract(payload_json,\'$.statement\') IS NOT NULL LIMIT 10001').bind(owner,marker).all<{payload_json:string}>()).results;if(versions.length>10000)return false;
 for(const raw of versions){const v=evidenceVersionSchema.parse(JSON.parse(raw.payload_json));if(v.sourceRecordId!==marker)continue;const rawSaved=JSON.parse(v.statement),saved=validate(rawSaved);const exact=await contentHash(canonical(rawSaved))===a.reportSha256;const legacyProjection=j.kind==='brief'&&j.briefing&&j.briefing.version<4&&canonical(rawSaved)===canonical(validateProjectBriefing(j.briefing));if(saved.run.id!==a.runId||!exact&&!legacyProjection)continue;const links=(await db.prepare('SELECT payload_json FROM evidence_links WHERE user_id=? AND json_extract(payload_json,\'$.evidenceId\')=? AND json_extract(payload_json,\'$.evidenceVersion\')=? LIMIT 201').bind(owner,v.id,v.version).all<{payload_json:string}>()).results;if(links.some(raw=>{const link=evidenceLinkSchema.parse(JSON.parse(raw.payload_json));return link.subject.type==='project'&&link.subject.id===j.projectId&&link.relation==='context';}))return true;}
 return false;
}
export async function changePersonalState(db:SqlDatabase,c:PersonalConnectorConfiguration,input:unknown,actor:'owner'|'device',now:string){const action=actor==='owner'?parseOwnerAction(input):parseDeviceAction(input);let writeAttempted=false;const finish=async(value:PersonalState)=>{if(actor==='device'&&value.connected)await db.prepare('UPDATE personal_repository_state SET last_seen_at=? WHERE user_id=? AND id=? AND archived_at IS NULL AND json_extract(payload_json,\'$.connected\')=1 AND json_extract(payload_json,\'$.epoch\')=?').bind(now,c.ownerId,c.deviceId,value.epoch).run();return value;};for(let attempt=0;attempt<3;attempt++){
 const {state,row}=await current(db,c);
 const rejectPure=(message:string,status:number):never=>{const knownRequest='requestId'in action&&state.requests.some(request=>request.id===action.requestId);throw !writeAttempted&&!knownRequest?new PersonalRequestRejectedError(message,status):new RequestError(message,status);};
 let projectRevision:number|undefined;let framing:ProjectFraming|undefined;let repositoryKeys:string[]|undefined;
 // Policy membership follows the current project; the revision fence prevents stale poll projection.
 if(actor==='device'&&action.action==='poll'&&state.policies?.length){const workspace=await readCurrent(db,c.ownerId,now);projectRevision=workspace.revision;const policies=new Map<string,PersonalState['policies'][number]>();for(const policy of [...state.policies].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){if(policies.has(policy.projectId))continue;const project=workspace.workspace.projects.find(project=>project.id===policy.projectId);const keys=project?.personalRepositoryKeys??(project?.personalRepositoryKey?[project.personalRepositoryKey]:[]);if(!project||project.archivedAt!==null||!keys.length)policy.enabled=false;else{policy.repositoryKey=keys[0];policy.repositoryKeys=[...keys];}policies.set(policy.projectId,policy);}state.policies=[...policies.values()];}
 // Framing is projected server-side so clients cannot supply a different project reference.
 const projectFor=actor==='owner'&&['analyze','brief','keep-current'].includes(action.action)?(action as {projectId:string}).projectId:actor==='device'&&action.action==='auto-brief'?(state.policies??[]).find(p=>p.enabled&&(action.projectId?p.projectId===action.projectId:p.repositoryKey===action.repositoryKey))?.projectId??null:null;
 if(projectFor!==null){const workspace=await readCurrent(db,c.ownerId,now);const project=workspace.workspace.projects.find(p=>p.id===projectFor&&p.archivedAt===null);if(!project){if(actor==='owner')rejectPure('Choose an active project.',400);throw new RequestError('Automatic briefing is not admitted right now.',409);}
  const repositoryKey='repositoryKey'in action?action.repositoryKey:null;
  repositoryKeys=project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[]);
  const conflicting=repositoryKey&&(repositoryKeys.length>0&&!repositoryKeys.includes(repositoryKey)||workspace.workspace.projects.some(p=>p.id!==projectFor&&(p.personalRepositoryKeys??(p.personalRepositoryKey?[p.personalRepositoryKey]:[])).includes(repositoryKey)));
  if(conflicting){if(actor==='owner')rejectPure('This folder is associated with another project.',409);throw new RequestError('This folder is associated with another project.',409);}
  if(['brief','auto-brief','keep-current'].includes(action.action)&&!repositoryKeys.length){if(actor==='owner')rejectPure('Add a folder to this project first.',409);throw new RequestError('Automatic briefing is not admitted right now.',409);}
  projectRevision=workspace.revision;if(action.action==='brief'||action.action==='auto-brief')framing=projectFraming(workspace.workspace,projectFor,workspace.revision);}
 if(actor==='owner'&&action.action==='ack'&&!await savedResultMatches(db,c.ownerId,action,state))throw new RequestError('Save this report to its project before acknowledging it.',409);
 if(actor==='device'&&action.action==='complete'){const prior=state.requests.find(j=>j.id===action.requestId);if(prior?.status==='completed'){if(prior.kind==='analyze'&&action.report&&prior.reportSha256===await contentHash(canonical(action.report))||prior.kind==='brief'&&action.briefing&&prior.reportSha256===await contentHash(canonical(action.briefing))||prior.kind==='browse'&&action.repositories&&canonical(state.repositories)===canonical(action.repositories))return finish(state);throw new RequestError('Completion differs from the recorded result.',409);}}
 let next:PersonalState=(()=>{try{return transitionPersonalState(state,action,now,actor,{framing,repositoryKeys});}catch(error){return rejectPure(error instanceof Error?error.message:'Personal PC request is invalid.',409);}})();
 for(const job of next.requests){const result=job.report??job.briefing;if(result&&!job.reportSha256)job.reportSha256=await contentHash(canonical(result));}
 next=validatePersonalState(next);const payload=canonical(next),hash=await contentHash(payload);
 if(row&&payload===row.payload_json)return finish(next);
 // Fence the active-project read in the same statement as enqueue. An older
 // in-flight request cannot commit after a later project rejection is delivered.
 const projectGuard=projectRevision===undefined?'':' AND EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)';
 const projectBindings=projectRevision===undefined?[]:[c.ownerId,projectRevision];
 writeAttempted=true;
 const result=row?await db.prepare('UPDATE personal_repository_state SET row_revision=row_revision+1,payload_json=?,content_hash=? WHERE user_id=? AND id=? AND row_revision=? AND content_hash=? AND archived_at IS NULL'+projectGuard).bind(payload,hash,c.ownerId,c.deviceId,row.row_revision,row.content_hash,...projectBindings).run():await db.prepare('INSERT INTO personal_repository_state(user_id,id,row_revision,payload_json,content_hash,created_at,archived_at) SELECT ?,?,1,?,?,?,NULL WHERE 1=1'+projectGuard+' ON CONFLICT(user_id,id) DO NOTHING').bind(c.ownerId,c.deviceId,payload,hash,now,...projectBindings).run();if(result.meta.changes===1)return finish(next);
 }throw new RequestError('Personal PC state changed. Retry the same request.',409);}
/** Device projection: the claimed job travels with its server-projected framing; policies tell the device which repositories may be briefed automatically. */
export function personalDeviceView(s:PersonalState){
 const claimed=s.requests.find(j=>j.status==='claimed'&&(j.kind!=='brief'||j.framing))??null;
 const job:PersonalJob|null=claimed?(({report,briefing,...rest})=>{void report;void briefing;return rest;})(claimed):null;
 return{job,state:{connected:s.connected,epoch:s.epoch},activeJobs:s.requests.filter(j=>['queued','claimed','cancelled','failed'].includes(j.status)).map(j=>({id:j.id,status:j.status})),
  policies:(s.policies??[]).filter(p=>p.enabled&&(p.repositoryKeys??[p.repositoryKey]).every(key=>s.repositories.some(repository=>repository.key===key))).map(({projectId,repositoryKey,repositoryKeys,provider,minIntervalMinutes,lastBriefAt,lastAttemptAt,lastFingerprint})=>({projectId,repositoryKey,repositoryKeys:repositoryKeys??[repositoryKey],provider,minIntervalMinutes,lastBriefAt,lastAttemptAt,lastFingerprint}))};
}
