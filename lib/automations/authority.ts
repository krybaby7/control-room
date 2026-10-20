import {projectReviewScope} from '../reviews/scope.ts';
import {z} from 'zod';
import {readCurrent,type SqlDatabase} from '../workspace-store.ts';
import {ownerReader} from '../workspace-modules.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceIdSchema,evidenceDateSchema} from '../evidence-validation.ts';
import {reviewScopeSchema} from '../reviews/validation.ts';
import {automationScheduleSchema} from './validation.ts';
import {readAutomationRuntime} from './store.ts';
const inputSchema=z.object({scheduleId:evidenceIdSchema,configurationHash:z.string().regex(/^[a-f0-9]{64}$/),dueAt:evidenceDateSchema,intentId:evidenceIdSchema,executionEpoch:z.number().int().nonnegative().safe(),now:evidenceDateSchema}).strict();
export type AutomationJobAuthorityInput=z.infer<typeof inputSchema>;
export interface AutomationJobAuthority {sql:string;bindings:(string|number|null)[];principalId:string}
function all(...clauses:string[]):string{if(clauses.length===1)return clauses[0];const mid=Math.floor(clauses.length/2);return `(${all(...clauses.slice(0,mid))} AND ${all(...clauses.slice(mid))})`;}
/** Current private scheduled-review authority only. Embed the returned predicate in the effects batch.
 * The principal ID is a required identity binding, never proof that the caller authenticated that principal.
 * Source adapters and backup storage require separate runtime authority and remain unsupported here.
 */
export async function automationJobAuthorityGuard(db:SqlDatabase,owner:string,raw:AutomationJobAuthorityInput):Promise<AutomationJobAuthority|null>{
 if(!owner||owner.trim()!==owner||owner.length>256||/[\u0000-\u001f\u007f]/u.test(owner))return null;const parsed=inputSchema.safeParse(raw);if(!parsed.success)return null;const input=parsed.data;if(Date.parse(input.dueAt)>Date.parse(input.now))return null;
 const row=await ownerReader(db,owner).get('automation_schedules',input.scheduleId);if(!row)return null;
 let schedule,runtime;try{schedule=automationScheduleSchema.parse(JSON.parse(row.payload_json));runtime=await readAutomationRuntime(db,owner,input.scheduleId);}catch{return null;}
 if(schedule.id!==input.scheduleId||!['daily_review','weekly_review'].includes(schedule.kind)||!schedule.enabled||schedule.archivedAt!==null||row.content_hash!==input.configurationHash||await contentHash(canonical(schedule))!==row.content_hash||!runtime||runtime.paused||runtime.configurationHash!==input.configurationHash||runtime.executionEpoch!==input.executionEpoch||!runtime.principalRef)return null;
 const principalId=runtime.principalRef,current=await readCurrent(db,owner,input.now),projectIds=[...schedule.projectIds].sort();if(projectIds.some(id=>!current.workspace.projects.some(p=>p.id===id&&p.archivedAt===null)))return null;
 const workspaceRow=await db.prepare('SELECT content,revision FROM workspaces WHERE user_id=?').bind(owner).first<{content:string;revision:number}>();if(!workspaceRow||workspaceRow.revision!==current.revision)return null;
 const scope=await projectReviewScope(projectIds),scopeHash=await contentHash(canonical(scope));
 const extension=await db.prepare('SELECT j.subject_id,j.configuration_hash,i.payload_json FROM integration_jobs j JOIN workspace_job_intents i ON i.user_id=j.user_id AND i.id=j.intent_id WHERE j.user_id=? AND j.intent_id=?').bind(owner,input.intentId).first<{subject_id:string;configuration_hash:string;payload_json:string}>();if(!extension||extension.payload_json.length>32_768)return null;
 try{const payload=z.object({snapshotId:evidenceIdSchema,scope:reviewScopeSchema}).strict().parse(JSON.parse(extension.payload_json));if(payload.snapshotId!==extension.subject_id||canonical(payload.scope)!==canonical(scope)||extension.configuration_hash!==scopeHash)return null;}catch{return null;}
 const scheduleGuard=all('s.user_id=?','s.id=?','s.row_revision=?','s.content_hash=?','s.payload_json=?','s.enabled=1','s.archived_at IS NULL','s.kind=?','r.user_id=s.user_id','r.schedule_id=s.id','r.operational_revision=?','r.configuration_hash=s.content_hash','r.execution_epoch=?','r.paused=0','r.principal_ref=?');
 const jobGuard=all('j.user_id=s.user_id','j.intent_id=?',"j.job_subject_kind='review'",'j.source_id IS NULL','j.subject_id=?','j.configuration_hash=?','j.schedule_id=s.id','j.schedule_configuration_hash=s.content_hash','j.occurrence_due_at=?','i.user_id=j.user_id','i.id=j.intent_id',"i.kind='review_generate'","i.status IN ('pending','running')",'i.cancel_requested=0','i.execution_epoch=r.execution_epoch','i.payload_json=?','julianday(i.not_before)<=julianday(?)');
 const occurrenceGuard=all('o.user_id=j.user_id','o.schedule_id=s.id','o.due_at=j.occurrence_due_at','o.intent_id=j.intent_id','o.configuration_hash=s.content_hash','o.execution_epoch=r.execution_epoch','o.principal_ref=r.principal_ref','julianday(o.admitted_at)<=julianday(?)');
 const principalGuard=all('p.user_id=r.user_id','p.id=r.principal_ref','length(p.token_hash)=64',"p.token_hash NOT GLOB '*[^a-f0-9]*'",'p.revoked_at IS NULL','julianday(p.renewable_verified_at)<=julianday(?)','julianday(p.expires_at)>julianday(?)','length(p.scope_json)<=128','json_valid(p.scope_json)',"json_type(CASE WHEN json_valid(p.scope_json) THEN p.scope_json ELSE 'null' END)='array'","json_array_length(CASE WHEN json_valid(p.scope_json) THEN p.scope_json ELSE 'null' END)=1","json_extract(CASE WHEN json_valid(p.scope_json) THEN p.scope_json ELSE 'null' END,'$[0]')='automation:run'",'c.user_id=p.user_id','c.principal_ref=p.id','c.kind=s.kind','c.resource_id=s.id',"c.proof_kind='live-unattended'",'julianday(c.verified_at)<=julianday(?)','julianday(c.expires_at)>julianday(?)');
 const sql=`EXISTS(SELECT 1 FROM automation_schedules s JOIN automation_runtime r ON r.user_id=s.user_id AND r.schedule_id=s.id JOIN integration_jobs j ON j.user_id=s.user_id AND j.schedule_id=s.id JOIN workspace_job_intents i ON i.user_id=j.user_id AND i.id=j.intent_id JOIN automation_occurrence_claims o ON o.user_id=j.user_id AND o.intent_id=j.intent_id JOIN integration_service_principals p ON p.user_id=r.user_id AND p.id=r.principal_ref JOIN automation_capabilities c ON c.user_id=p.user_id AND c.principal_ref=p.id WHERE ${all(scheduleGuard,jobGuard,occurrenceGuard,principalGuard,'COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=s.user_id),0)=r.execution_epoch','EXISTS(SELECT 1 FROM workspaces w WHERE w.user_id=s.user_id AND w.revision=? AND w.content=?)')})`;
 const bindings=[owner,input.scheduleId,row.row_revision,row.content_hash,row.payload_json,schedule.kind,runtime.operationalRevision,input.executionEpoch,principalId,input.intentId,extension.subject_id,scopeHash,input.dueAt,extension.payload_json,input.now,input.now,input.now,input.now,input.now,input.now,current.revision,workspaceRow.content];
 if(!await db.prepare(`SELECT 1 WHERE ${sql}`).bind(...bindings).first())return null;return {sql,bindings,principalId};
}
