import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema,evidenceIdSchema} from '../evidence-validation.ts';
import {sourceFailureSchema} from '../sources/validation.ts';
import {automationFailureSchema} from '../automations/validation.ts';
import type {NotificationEvent,NotificationPreferences,ReviewFact,ReviewSnapshot} from './contracts.ts';
import {notificationEventSchema,notificationPreferencesSchema,reviewHrefSchema,reviewSnapshotSchema} from './validation.ts';
const ordered=(values:unknown[])=>values.map(value=>canonical(value)).sort();
/** Global editor revisions are snapshot coordinates, not a changed entity when its exact hash stays equal. */
function semanticFact(fact:ReviewFact){return {kind:fact.kind,projectId:fact.projectId,text:fact.text,basis:fact.basis,observedAt:fact.observedAt,sourceUpdatedAt:fact.sourceUpdatedAt,evidenceRefs:ordered(fact.evidenceRefs),decisionRefs:ordered(fact.decisionRefs),observationRefs:ordered(fact.observationRefs),planningRefs:ordered(fact.planningRefs.map(ref=>({kind:ref.kind,id:ref.id,contentHash:ref.contentHash}))),auditRefs:ordered(fact.auditRefs.map(ref=>({eventId:ref.eventId,contentHash:ref.contentHash}))) };}
/** Meaningful review signals only. Store insertion must preserve the first event/citation
 * for an existing semantic dedupKey; a later generation is not a new underlying fact.
 */
export async function reviewNotifications(snapshot:ReviewSnapshot):Promise<NotificationEvent[]>{
 const checked=reviewSnapshotSchema.parse(snapshot) as ReviewSnapshot,snapshotHash=await contentHash(canonical(checked)),events=new Map<string,NotificationEvent>();
 for(const fact of checked.facts){if(fact.kind==='progress')continue;const dedupKey=await contentHash(canonical({type:'review-fact',fact:semanticFact(fact)})),existing=events.get(dedupKey);if(existing){existing.factIds.push(fact.id);continue;}
  events.set(dedupKey,notificationEventSchema.parse({id:`notification_${dedupKey}`,dedupKey,kind:fact.kind,severity:fact.kind==='decision'?'info':'warning',projectId:fact.projectId,sourceId:null,title:fact.kind==='blocker'?'Blocker needs review':fact.kind==='decision'?'Owner decision needs review':fact.kind==='deadline'?'Deadline needs review':'Stale context needs review',body:fact.text,href:fact.href,createdAt:checked.generatedAt,factIds:[fact.id],snapshotRef:{id:checked.id,hash:snapshotHash},observationRefs:fact.observationRefs,evidenceRefs:fact.evidenceRefs}));
 }return [...events.values()].map(event=>notificationEventSchema.parse(event));
}
export const jobNotificationInputSchema=z.object({jobId:evidenceIdSchema,outcome:z.enum(['completed','failed','recovered']),failureClass:z.union([sourceFailureSchema,automationFailureSchema]).nullable(),sourceId:evidenceIdSchema.nullable(),projectId:evidenceIdSchema.nullable(),createdAt:evidenceDateSchema,href:reviewHrefSchema,detail:z.string().max(7500).optional()}).strict().superRefine((value,ctx)=>{if((value.outcome==='failed')!==(value.failureClass!==null))ctx.addIssue({code:'custom',message:'Only a failed job identifies a known failure class.'});});
export type JobNotificationInput=z.infer<typeof jobNotificationInputSchema>;
/** No provider string is a command or executable payload. Repeated failure wording coalesces
 * by actual job/outcome/class. Recovery is a distinct explicit terminal signal.
 */
export async function jobNotification(input:JobNotificationInput):Promise<NotificationEvent>{
 const value=jobNotificationInputSchema.parse(input),dedupKey=await contentHash(canonical({type:'job-outcome',jobId:value.jobId,outcome:value.outcome,failureClass:value.failureClass,sourceId:value.sourceId,projectId:value.projectId})),kind=value.outcome==='completed'?'job_completed':value.outcome==='failed'?'job_failed':'recovery';
 const title=value.outcome==='completed'?'Requested job completed':value.outcome==='failed'?'Background job needs review':'Integration recovery recorded';const body=`Job ${value.jobId} · ${value.outcome}${value.failureClass?` · ${value.failureClass}`:''}.${value.detail?`\n${value.detail}`:''}`;
 return notificationEventSchema.parse({id:`notification_${dedupKey}`,dedupKey,kind,severity:value.outcome==='failed'?'error':'info',projectId:value.projectId,sourceId:value.sourceId,title,body,href:value.href,createdAt:value.createdAt,factIds:[],snapshotRef:null,observationRefs:[],evidenceRefs:[]});
}
export function defaultNotificationPreferences():NotificationPreferences{return {id:'notifications',mutedKinds:[],mutedSourceIds:[],quietHours:{enabled:false,timezone:'Africa/Cairo',start:'22:00',end:'08:00'},externalDelivery:'disabled'};}
export const DEFAULT_NOTIFICATION_PREFERENCES:Readonly<NotificationPreferences>=Object.freeze(defaultNotificationPreferences());
export interface NotificationVisibility {visible:boolean;reason:'visible'|'muted-kind'|'muted-source'|'quiet-hours';externalDelivery:'disabled'}
const cairoClock=new Intl.DateTimeFormat('en-GB-u-nu-latn',{timeZone:'Africa/Cairo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const minutes=(time:string)=>{const [hour,minute]=time.split(':').map(Number);return hour*60+minute;};
/** Presentation only. Hidden notifications remain immutable stored events; no read state
 * or external delivery is created by this helper. Quiet hours start inclusive/end exclusive.
 * Equal endpoints mean an empty quiet window, not an implicit all-day mute.
 */
export function notificationVisibility(event:NotificationEvent,prefs:NotificationPreferences|undefined,now:string):NotificationVisibility{
 const value=notificationEventSchema.parse(event),settings=notificationPreferencesSchema.parse(prefs??defaultNotificationPreferences());evidenceDateSchema.parse(now);const result=(reason:NotificationVisibility['reason']):NotificationVisibility=>({visible:reason==='visible',reason,externalDelivery:'disabled'});
 if(settings.mutedKinds.includes(value.kind))return result('muted-kind');if(value.sourceId!==null&&settings.mutedSourceIds.includes(value.sourceId))return result('muted-source');
 if(settings.quietHours.enabled){const current=minutes(cairoClock.format(new Date(now))),start=minutes(settings.quietHours.start),end=minutes(settings.quietHours.end),quiet=start<end?current>=start&&current<end:start>end&&(current>=start||current<end);if(quiet)return result('quiet-hours');}return result('visible');
}
