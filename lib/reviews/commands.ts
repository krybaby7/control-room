import {z} from 'zod';
import type {CommandHandler,PrepareContext,MutationPlan} from '../workspace-transaction.ts';
import type {ModuleRow,RegisteredOwnerTable} from '../workspace-modules.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {parseAuditEvent} from '../audit-events.ts';
import {CommandValidationError,ModuleConflictError} from '../workspace-errors.ts';
import {evidenceIdSchema as id,evidenceDateSchema} from '../evidence-validation.ts';
import {reviewScopeSchema,reviewSnapshotSchema,reviewAcknowledgementSchema,notificationEventSchema,notificationPreferencesSchema,analysisPolicySchema} from './validation.ts';
import {reviewSourceWatermark} from './freshness.ts';
import {automationScheduleSchema} from '../automations/validation.ts';
import {AUTOMATION_LIMITS,type AutomationSchedule} from '../automations/contracts.ts';
import {nextOccurrence} from '../automations/schedule.ts';
import {sourceTargetSchema,sourceConnectionSchema} from '../sources/validation.ts';
const revision=z.number().int().positive().safe(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const scheduleFields=automationScheduleSchema.innerType().omit({id:true,configurationVersion:true,createdAt:true,updatedAt:true,archivedAt:true});
const scheduleInput=scheduleFields.refine(value=>automationScheduleSchema.safeParse({...value,id:'validation',configurationVersion:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',archivedAt:null}).success,'Schedule kind, recurrence and exact source must agree.');
export const reviewCommandTypes=['reviews.request','reviews.acknowledge','notifications.read','notifications.preferences','analysis.configure','automations.create','automations.update','automations.pause','automations.resume','automations.archive'] as const;
export const reviewCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('reviews.request'),projectIds:reviewScopeSchema.shape.projectIds,filterDigest:hash}).strict(),
 z.object({type:z.literal('reviews.acknowledge'),snapshotId:id,snapshotHash:hash}).strict(),
 z.object({type:z.literal('notifications.read'),id,contentHash:hash,read:z.boolean()}).strict(),
 z.object({type:z.literal('notifications.preferences'),value:notificationPreferencesSchema,expectedRowRevision:revision.nullable()}).strict(),
 z.object({type:z.literal('analysis.configure'),value:analysisPolicySchema,expectedRowRevision:revision.nullable()}).strict(),
 z.object({type:z.literal('automations.create'),value:scheduleInput}).strict(),
 z.object({type:z.literal('automations.update'),id,expectedRowRevision:revision,patch:scheduleFields.partial().strict().refine(value=>Object.keys(value).length>0,'An explicit schedule change is required.')}).strict(),
 z.object({type:z.literal('automations.pause'),id,expectedRowRevision:revision}).strict(),
 z.object({type:z.literal('automations.resume'),id,expectedRowRevision:revision}).strict(),
 z.object({type:z.literal('automations.archive'),id,expectedRowRevision:revision}).strict(),
]);
export type ReviewCommand=z.infer<typeof reviewCommandSchema>;
async function prepare(context:PrepareContext):Promise<MutationPlan>{
 const command=reviewCommandSchema.parse(context.command);evidenceDateSchema.parse(context.now);
 const plan:MutationPlan={planningAfter:structuredClone(context.before.workspace),writes:[],preconditions:[],events:[],jobs:[],reviewGrants:[],notificationReads:[],automationControls:[],reviewJobs:[]};
 const seen=new Map<string,ModuleRow>();
 async function read(table:RegisteredOwnerTable,key:string){const row=await context.query.get(table,key);if(!row)return null;if(row.id!==key||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new ModuleConflictError('Stored review row identity, revision or content hash differs.');if(!seen.has(`${table}:${key}`)){seen.set(`${table}:${key}`,row);plan.preconditions!.push({table,id:key,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});}return row;}
 async function required(table:RegisteredOwnerTable,key:string,expected?:number){const row=await read(table,key);if(!row)throw new CommandValidationError('Review record is missing or unavailable for this owner.');if(expected!==undefined&&row.row_revision!==expected)throw new ModuleConflictError('The review row changed; refresh before confirming.');return row;}
 function write(table:RegisteredOwnerTable,key:string,value:unknown,row:ModuleRow|null){plan.writes.push({table,id:key,value:value as JsonValue,operation:row?'update':'insert',expectedRowRevision:row?.row_revision??null});}
 function projects(ids:string[],active:boolean){for(const key of ids){const project=context.before.workspace.projects.find(value=>value.id===key);if(!project||active&&project.archivedAt)throw new CommandValidationError('Choose existing active owner projects.');}}
 function durableMutation(){if(!context.mutationId||!/^[A-Za-z0-9_-]{16,128}$/.test(context.mutationId))throw new CommandValidationError('A durable owner mutation ID is required.');return context.mutationId;}
 async function source(key:string,active:boolean){const row=await required('source_targets',key),target=sourceTargetSchema.parse(JSON.parse(row.payload_json));if(target.id!==key)throw new ModuleConflictError('Source selection identity differs.');const connectionRow=await required('source_connections',target.connectionId),connection=sourceConnectionSchema.parse(JSON.parse(connectionRow.payload_json));if(connection.id!==target.connectionId||connection.provider!==(target.kind.startsWith('github_')?'github':target.kind==='document'?'documents':'conversation-export'))throw new ModuleConflictError('Source connection identity or provider differs.');projects([target.projectId],active);if(active&&(target.archivedAt||connection.archivedAt))throw new CommandValidationError('Restore the exact source and connection before scheduling.');return target;}
 async function validateSchedule(schedule:AutomationSchedule,active:boolean){projects(schedule.projectIds,active);if(schedule.sourceId)await source(schedule.sourceId,active);}
 async function control(schedule:AutomationSchedule,action:'pause'|'resume'){plan.automationControls!.push({scheduleId:schedule.id,configurationHash:await contentHash(canonical(schedule)),action,nextDueAt:nextOccurrence(schedule,context.now)});}
 let entityType='review',entityId:string|null='id'in command?command.id:null,sourceRef:string|null=null;
 if(command.type==='reviews.request'){
  projects(command.projectIds,false);const scope=reviewScopeSchema.parse({projectIds:[...command.projectIds].sort(),filterDigest:command.filterDigest});
  const digest=await contentHash(canonical([context.userId,durableMutation(),scope])),snapshotId=`review-request-${digest}`,intentId=`review-generate-${digest}`;
  plan.jobs.push({id:intentId,kind:'review_generate',dedupeKey:intentId,payload:{snapshotId,scope},notBefore:context.now});plan.reviewJobs!.push({intentId,snapshotId,scope});entityId=snapshotId;sourceRef=`review-request:${snapshotId}`;
 }else if(command.type==='reviews.acknowledge'){
  const row=await required('review_snapshots',command.snapshotId),snapshot=reviewSnapshotSchema.parse(JSON.parse(row.payload_json));
  if(snapshot.id!==row.id||row.content_hash!==command.snapshotHash)throw new ModuleConflictError('The exact reviewed snapshot hash differs.');
  for(const record of snapshot.planningRecords)if(await contentHash(canonical(record.value))!==record.contentHash)throw new ModuleConflictError('Frozen planning citation hash differs.');
  for(const record of snapshot.auditRecords)if(await contentHash(canonical(record.value))!==record.ref.contentHash)throw new ModuleConflictError('Frozen audit citation hash differs.');
  if(await reviewSourceWatermark(snapshot.sourceSet)!==snapshot.sourceWatermark)throw new ModuleConflictError('Frozen source watermark differs.');
  const acknowledgement=reviewAcknowledgementSchema.parse({id:`review-ack-${await contentHash(canonical([context.userId,durableMutation(),snapshot.id,command.snapshotHash]))}`,snapshotId:snapshot.id,snapshotHash:command.snapshotHash,scope:snapshot.scope,acknowledgedAt:context.now,coveredFactIds:snapshot.coverage.includedFactIds,coveredEventIds:snapshot.coverage.includedEventIds});
  const existing=await read('review_acknowledgements',acknowledgement.id),digest=await contentHash(canonical(acknowledgement));
  if(existing&&existing.content_hash!==digest)throw new ModuleConflictError('Acknowledgement identity already contains different content.');
  if(!existing)write('review_acknowledgements',acknowledgement.id,acknowledgement,null);
  plan.reviewGrants!.push({id:acknowledgement.id,hash:digest,snapshotId:snapshot.id,snapshotHash:command.snapshotHash});entityId=snapshot.id;sourceRef=`review:${snapshot.id}`;
 }else if(command.type==='notifications.read'){
  const row=await required('notification_events',command.id),notification=notificationEventSchema.parse(JSON.parse(row.payload_json));
  if(notification.id!==row.id||row.content_hash!==command.contentHash)throw new ModuleConflictError('The exact notification content hash differs.');
  plan.notificationReads!.push({id:notification.id,hash:row.content_hash,read:command.read});entityType='notification';entityId=notification.id;sourceRef=`notification:${notification.id}:${command.read?'read':'unread'}`;
 }else if(command.type==='notifications.preferences'||command.type==='analysis.configure'){
  const row=await read('review_settings',command.value.id);
  if(command.expectedRowRevision===null?row!==null:!row||row.row_revision!==command.expectedRowRevision)throw new ModuleConflictError('Review settings changed; reload before saving.');
  if(command.type==='notifications.preferences')for(const key of command.value.mutedSourceIds)await source(key,false);
  write('review_settings',command.value.id,command.value,row);entityType='review-settings';entityId=command.value.id;
 }else if(command.type==='automations.create'){
  let after:string|undefined,count=0;for(;;){const rows=await context.query.list('automation_schedules',{after,limit:200});for(const row of rows){if(after!==undefined&&row.id<=after)throw new ModuleConflictError('Schedule pagination order differs.');after=row.id;count++;}if(count>=AUTOMATION_LIMITS.schedules)throw new CommandValidationError('Owner automation schedule limit reached.');if(rows.length<200)break;}
  const schedule=automationScheduleSchema.parse({...command.value,id:crypto.randomUUID(),configurationVersion:1,createdAt:context.now,updatedAt:context.now,archivedAt:null});await validateSchedule(schedule,true);write('automation_schedules',schedule.id,schedule,null);await control(schedule,'pause');entityType='automation';entityId=schedule.id;
 }else{
  const row=await required('automation_schedules',command.id,command.expectedRowRevision),before=automationScheduleSchema.parse(JSON.parse(row.payload_json));if(before.id!==row.id)throw new ModuleConflictError('Schedule identity differs.');
  entityType='automation';entityId=before.id;
  if(command.type==='automations.update'||command.type==='automations.archive'){
   if(command.type==='automations.update'&&before.archivedAt)throw new CommandValidationError('Archived schedules cannot be edited.');
   const schedule=automationScheduleSchema.parse({...before,...(command.type==='automations.update'?command.patch:{}),configurationVersion:before.configurationVersion+1,updatedAt:context.now,archivedAt:command.type==='automations.archive'?before.archivedAt??context.now:before.archivedAt});
   if(command.type==='automations.update')await validateSchedule(schedule,true);write('automation_schedules',schedule.id,schedule,row);await control(schedule,'pause');
  }else if(command.type==='automations.resume'){
   if(!before.enabled||before.archivedAt)throw new CommandValidationError('Enable an active schedule before explicit resume.');await validateSchedule(before,true);
   if(!context.automationRuntime||!await context.automationRuntime.canResume(before))throw new CommandValidationError('Verified unattended automation authority is unavailable.');await control(before,'resume');
  }else await control(before,'pause');
 }
 plan.events.push(parseAuditEvent({id:crypto.randomUUID(),kind:command.type,entityType,entityId,changes:plan.writes.map(value=>{const before=seen.get(`${value.table}:${value.id}`);return {path:[value.table,value.id],before:{exists:!!before,value:before?JSON.parse(before.payload_json) as JsonValue:null},after:{exists:true,value:value.value!}};}),origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef,undoOf:null}));
 return plan;
}
export const reviewCommandHandler:CommandHandler={async prepare(context){try{return await prepare(context);}catch(error){if(error instanceof CommandValidationError||error instanceof ModuleConflictError)throw error;throw new CommandValidationError(error instanceof Error?error.message:'Invalid review command.');}}};
