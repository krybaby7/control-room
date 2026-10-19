import {z} from 'zod';
import {AUTOMATION_LIMITS} from './contracts.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema,evidenceIdSchema} from '../evidence-validation.ts';
import type {IntegrationPrincipal} from '../background/job-contract.ts';
import {runIntegrationJob,type IntegrationRunnerResult} from '../background/job-runner.ts';
import {sourceConfigurationHash} from '../background/job-store.ts';
import {sourceConnectionSchema,sourceTargetSchema} from '../sources/validation.ts';
import type {SourceAdapter,SourceConnection,SourceTarget} from '../sources/contracts.ts';
import {automationScheduleSchema,automationOccurrenceSchema} from './validation.ts';
import {sourceRunHistorySchema} from '../sources/validation.ts';
import {parseAuditEvent} from '../audit-events.ts';
import type {AutomationServicePrincipal} from './runner.ts';
export interface ScheduledSourceResolution {adapter:SourceAdapter;principal:IntegrationPrincipal}
/** Server-injected registry only. Never expose a transport/principal override in an HTTP body. */
export type ScheduledSourceResolver=(selection:{ownerId:string;intentId:string;connection:SourceConnection;target:SourceTarget;signal:AbortSignal})=>Promise<ScheduledSourceResolution|null>;
export type ScheduledSourceExecutionResult=IntegrationRunnerResult|{status:'replayed'};
export interface ScheduledSourceOptions {now:()=>string;signal?:AbortSignal;resolve?:ScheduledSourceResolver}
const sourcePayload=z.object({sourceId:evidenceIdSchema,configurationHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const principalSchema=z.object({ownerId:z.string().min(1).max(256),principalId:evidenceIdSchema,scope:z.tuple([z.literal('source:read')]),expiresAt:evidenceDateSchema}).strict();
const unavailable=():IntegrationRunnerResult=>({status:'blocked',reason:'unavailable'});
/** Executes one admitted foundation source intent through the existing source runner.
 * No provider is configured here: absent a server resolver the default is unsupported.
 * The automation and provider-read principals must be distinct current registrations;
 * the source claim rechecks both authorities atomically before any portable writes.
 */
export async function runScheduledSource(db:SqlDatabase,automationPrincipal:AutomationServicePrincipal,intentId:string,options:ScheduledSourceOptions):Promise<ScheduledSourceExecutionResult>{
 if(!automationPrincipal.ownerId||automationPrincipal.ownerId.trim()!==automationPrincipal.ownerId||automationPrincipal.ownerId.length>256||/[\u0000-\u001f\u007f]/u.test(automationPrincipal.ownerId))throw new Error('An authenticated automation scope is required.');
 evidenceIdSchema.parse(automationPrincipal.principalId);evidenceIdSchema.parse(intentId);const now=evidenceDateSchema.parse(options.now());if(options.signal?.aborted)return unavailable();
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();const timer=setTimeout(abort,AUTOMATION_LIMITS.runMs),signal=controller.signal;
 try{
 const owner=automationPrincipal.ownerId;
 const stored=await db.prepare(`SELECT i.kind,i.status,i.cancel_requested,i.execution_epoch,i.payload_json,j.source_id,j.subject_id,j.job_subject_kind,j.schedule_id,j.schedule_configuration_hash,j.occurrence_due_at,j.configuration_hash,t.payload_json target_json,t.content_hash target_hash,c.payload_json connection_json,c.content_hash connection_hash,s.payload_json schedule_json,s.content_hash schedule_hash,r.principal_ref,r.paused runtime_paused,r.configuration_hash runtime_hash,r.execution_epoch runtime_epoch,o.principal_ref occurrence_principal,o.configuration_hash occurrence_hash,o.execution_epoch occurrence_epoch,COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=i.user_id),0) current_epoch FROM workspace_job_intents i JOIN integration_jobs j ON j.user_id=i.user_id AND j.intent_id=i.id JOIN source_targets t ON t.user_id=j.user_id AND t.id=j.source_id JOIN source_connections c ON c.user_id=t.user_id AND c.id=t.connection_id JOIN automation_schedules s ON s.user_id=j.user_id AND s.id=j.schedule_id JOIN automation_runtime r ON r.user_id=s.user_id AND r.schedule_id=s.id JOIN automation_occurrence_claims o ON o.user_id=j.user_id AND o.intent_id=j.intent_id AND o.schedule_id=s.id AND o.due_at=j.occurrence_due_at WHERE i.user_id=? AND i.id=?`).bind(owner,intentId).first<Record<string,unknown>>();
 if(!stored)return unavailable();
 let connection:SourceConnection,target:SourceTarget;
 try{
  const payload=sourcePayload.parse(JSON.parse(stored.payload_json as string)),schedule=automationScheduleSchema.parse(JSON.parse(stored.schedule_json as string));target=sourceTargetSchema.parse(JSON.parse(stored.target_json as string));connection=sourceConnectionSchema.parse(JSON.parse(stored.connection_json as string));
  if(stored.kind!=='source_refresh'||stored.job_subject_kind!=='source'||!['pending','running','completed','failed','cancelled'].includes(stored.status as string)||stored.cancel_requested!==0||stored.source_id!==payload.sourceId||stored.subject_id!==payload.sourceId||stored.configuration_hash!==payload.configurationHash||target.id!==payload.sourceId||target.connectionId!==connection.id||connection.accessMode!=='unattended'||!connection.enabled||connection.archivedAt!==null||target.archivedAt!==null||schedule.kind!=='source_refresh'||schedule.sourceId!==target.id||!schedule.enabled||schedule.archivedAt!==null||schedule.id!==stored.schedule_id||stored.runtime_paused!==0||stored.principal_ref!==automationPrincipal.principalId||stored.occurrence_principal!==automationPrincipal.principalId||stored.execution_epoch!==stored.current_epoch||stored.runtime_epoch!==stored.current_epoch||stored.occurrence_epoch!==stored.current_epoch||stored.schedule_configuration_hash!==stored.schedule_hash||stored.runtime_hash!==stored.schedule_hash||stored.occurrence_hash!==stored.schedule_hash||!evidenceDateSchema.safeParse(stored.occurrence_due_at).success||Date.parse(stored.occurrence_due_at as string)>Date.parse(now)||await contentHash(canonical(schedule))!==stored.schedule_hash||await contentHash(canonical(target))!==stored.target_hash||await contentHash(canonical(connection))!==stored.connection_hash||await sourceConfigurationHash(connection,target)!==payload.configurationHash)return unavailable();
 }catch{return unavailable();}
 const authorized=await db.prepare("SELECT 1 FROM integration_service_principals p JOIN automation_capabilities c ON c.user_id=p.user_id AND c.principal_ref=p.id WHERE p.user_id=? AND p.id=? AND length(p.token_hash)=64 AND p.token_hash NOT GLOB '*[^a-f0-9]*' AND p.revoked_at IS NULL AND julianday(p.renewable_verified_at)<=julianday(?) AND julianday(p.expires_at)>julianday(?) AND length(p.scope_json)<=128 AND json_valid(p.scope_json) AND json_type(p.scope_json)='array' AND json_array_length(p.scope_json)=1 AND json_extract(p.scope_json,'$[0]')='automation:run' AND c.kind='source_refresh' AND c.resource_id=? AND c.proof_kind='live-unattended' AND julianday(c.verified_at)<=julianday(?) AND julianday(c.expires_at)>julianday(?)").bind(owner,automationPrincipal.principalId,now,now,target.id,now,now).first();
 if(!authorized)return unavailable();
 if(['completed','failed','cancelled'].includes(stored.status as string)){
  try{
   const occurrenceRow=await db.prepare('SELECT id,payload_json,content_hash FROM automation_occurrences WHERE user_id=? AND schedule_id=? AND due_at=?').bind(owner,stored.schedule_id as string,stored.occurrence_due_at as string).first<{id:string;payload_json:string;content_hash:string}>();if(!occurrenceRow)return unavailable();
   const occurrence=automationOccurrenceSchema.parse(JSON.parse(occurrenceRow.payload_json)),expectedId=`occurrence_${await contentHash(canonical([owner,stored.schedule_id,stored.occurrence_due_at]))}`;
   if(occurrence.id!==occurrenceRow.id||occurrence.id!==expectedId||occurrence.scheduleId!==stored.schedule_id||occurrence.dueAt!==stored.occurrence_due_at||occurrence.configurationHash!==stored.schedule_configuration_hash||await contentHash(canonical(occurrence))!==occurrenceRow.content_hash||occurrence.resultRef?.kind!=='source-run'||!occurrence.resultRef.hash)return unavailable();
   const runRow=await db.prepare('SELECT payload_json,content_hash FROM source_sync_runs WHERE user_id=? AND id=?').bind(owner,occurrence.resultRef.id).first<{payload_json:string;content_hash:string}>();if(!runRow)return unavailable();const run=sourceRunHistorySchema.parse(JSON.parse(runRow.payload_json));
   const expectedOutcome=stored.status==='completed'?'success':stored.status==='cancelled'?'cancelled':'failed';
   if(run.id!==occurrence.resultRef.id||run.sourceId!==target.id||runRow.content_hash!==occurrence.resultRef.hash||await contentHash(canonical(run))!==runRow.content_hash||occurrence.outcome!==expectedOutcome||Date.parse(run.finishedAt)>Date.parse(evidenceDateSchema.parse(options.now()))||(stored.status==='completed'?!['success','unchanged'].includes(run.outcome):run.outcome!==stored.status)||run.retryAt!==null)return unavailable();
   const eventId=`automation_source_${await contentHash(canonical([owner,intentId,occurrence.id]))}`,eventRow=await db.prepare("SELECT payload_json,origin,actor_id,source_ref,stream_id,stream_sequence FROM audit_events WHERE user_id=? AND event_id=? AND kind='automation.source.finished'").bind(owner,eventId).first<{payload_json:string;origin:string;actor_id:string;source_ref:string;stream_id:string;stream_sequence:number}>();if(!eventRow)return unavailable();const event=parseAuditEvent(JSON.parse(eventRow.payload_json));
   const summary={occurrenceId:occurrence.id,resultRef:occurrence.resultRef,outcome:occurrence.outcome,executionEpoch:stored.execution_epoch};
   if(event.id!==eventId||event.kind!=='automation.source.finished'||event.entityType!=='automation'||event.entityId!==stored.schedule_id||event.origin!=='system'||event.actorId!=='automation-runner'||event.sourceRef!==runRow.content_hash||eventRow.origin!==event.origin||eventRow.actor_id!==event.actorId||eventRow.source_ref!==event.sourceRef||eventRow.stream_id!=='automations'||!Number.isSafeInteger(eventRow.stream_sequence)||eventRow.stream_sequence<1||event.changes.length!==1||canonical(event.changes[0].path)!==canonical(['result'])||!event.changes[0].after.exists||canonical(event.changes[0].after.value)!==canonical(summary)||event.occurredAt!==occurrence.finishedAt)return unavailable();
   const head=await db.prepare("SELECT last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id='automations'").bind(owner).first<{last_sequence:number}>(),epoch=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>();if(!head||head.last_sequence<eventRow.stream_sequence||(epoch?.epoch??0)!==stored.execution_epoch)return unavailable();
   return {status:'replayed'};
  }catch{return unavailable();}
 }
 if(!options.resolve)return {status:'blocked',reason:'unsupported'};
 if(signal.aborted)return unavailable();
 let resolved:ScheduledSourceResolution|null;
 try{resolved=await new Promise<ScheduledSourceResolution|null>((resolve,reject)=>{const stopped=()=>reject(new Error('Scheduled source resolution cancelled.'));signal.addEventListener('abort',stopped,{once:true});Promise.resolve().then(()=>options.resolve!({ownerId:owner,intentId,connection:structuredClone(connection),target:structuredClone(target),signal})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stopped));});}catch{return unavailable();}
 if(!resolved)return {status:'blocked',reason:'unsupported'};if(signal.aborted)return unavailable();
 const parsed=principalSchema.safeParse(resolved.principal);if(!parsed.success||parsed.data.ownerId!==owner||parsed.data.principalId===automationPrincipal.principalId||Date.parse(parsed.data.expiresAt)<=Date.parse(evidenceDateSchema.parse(options.now())))return unavailable();const principal=parsed.data;
 const proof=await db.prepare('SELECT token_hash,scope_json,expires_at,renewable_verified_at,revoked_at FROM integration_service_principals WHERE user_id=? AND id=?').bind(owner,principal.principalId).first<{token_hash:string;scope_json:string;expires_at:string;renewable_verified_at:string;revoked_at:string|null}>();
 const at=evidenceDateSchema.parse(options.now());try{if(!proof||!/^[a-f0-9]{64}$/.test(proof.token_hash)||proof.revoked_at!==null||proof.scope_json.length>128||canonical(JSON.parse(proof.scope_json))!==canonical(['source:read'])||proof.expires_at!==principal.expiresAt||Date.parse(evidenceDateSchema.parse(proof.expires_at))<=Date.parse(at)||Date.parse(evidenceDateSchema.parse(proof.renewable_verified_at))>Date.parse(at))return unavailable();}catch{return unavailable();}
 const grant=await db.prepare("SELECT resource_scope_json FROM source_access_grants WHERE user_id=? AND connection_id=? AND mode='unattended' AND principal_ref=? AND revoked_at IS NULL AND julianday(verified_at)<=julianday(?) AND julianday(expires_at)>julianday(?)").bind(owner,connection.id,principal.principalId,at,at).first<{resource_scope_json:string}>();
 try{const resources=z.array(z.string().min(1).max(512).refine(value=>value.trim()===value)).max(100).parse(JSON.parse(grant?.resource_scope_json??'null'));if(new Set(resources).size!==resources.length||!resources.includes(target.providerResourceId))return unavailable();}catch{return unavailable();}
 if(signal.aborted)return unavailable();
 return await runIntegrationJob(db,owner,intentId,{authority:{mode:'unattended',principal},automationPrincipal,now:options.now,signal,resolveAdapter:async(currentConnection,currentTarget,authority)=>canonical(currentConnection)===canonical(connection)&&canonical(currentTarget)===canonical(target)&&authority.mode==='unattended'&&canonical(authority.principal)===canonical(principal)?resolved.adapter:null});
 }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
