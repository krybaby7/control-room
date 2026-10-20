import {z} from 'zod';
import {OWNER_TABLES,type ModuleRow,type RegisteredOwnerTable} from './workspace-modules.ts';
import type {CommandHandler,PrepareContext,MutationPlan} from './workspace-transaction.ts';
import type {ReferenceSnapshot} from './workspace-references.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {versionRowId} from './version-identity.ts';
import {evidenceIdSchema,evidenceSubjectSchema,evidenceHeadSchema,evidenceVersionSchema,evidenceLinkSchema} from './evidence-validation.ts';
import {requirementCriteriaSchema,evidenceRequirementSchema,sameSubject,type VerifiedAttachment} from './evidence-requirements.ts';
import {acceptanceRecordSchema,previewAcceptance} from './acceptance.ts';
import {decisionVersionSchema} from './decisions.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {parseAuditEvent} from './audit-events.ts';
import {CommandValidationError,ModuleConflictError} from './workspace-errors.ts';
import type {EvidenceSubject,DecisionVersion} from './evidence-contract.ts';
const requirementInput=requirementCriteriaSchema.omit({id:true}).extend({subject:evidenceSubjectSchema}).strict();
const expectedRowRevision=z.number().int().positive().safe();
export const acceptanceCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('evidence.requirement.create'),value:requirementInput}).strict(),
 z.object({type:z.literal('evidence.requirement.revise'),id:evidenceIdSchema,expectedRowRevision,value:requirementInput}).strict(),
 z.object({type:z.literal('evidence.requirement.archive'),id:evidenceIdSchema,expectedRowRevision}).strict(),
 z.object({type:z.literal('evidence.requirement.restore'),id:evidenceIdSchema,expectedRowRevision}).strict(),
 z.object({type:z.literal('acceptance.record'),value:acceptanceRecordSchema.omit({id:true,recordedAt:true}).strict()}).strict(),
]);
function subjectExists(ctx:PrepareContext,subject:EvidenceSubject){const w=ctx.before.workspace;return (subject.type==='project'?w.projects:subject.type==='milestone'?w.milestones:subject.type==='task'?w.tasks:w.captures).some(row=>row.id===subject.id);}
async function load(ctx:PrepareContext){
 const tables=new Map<RegisteredOwnerTable,ModuleRow[]>();const snapshot:ReferenceSnapshot={coveredModules:[...OWNER_TABLES],rows:[],digest:''};let count=0,bytes=0;
 for(const table of OWNER_TABLES){const rows:ModuleRow[]=[];let after='';for(;;){const page=await ctx.query.list(table,{after,limit:200});if(page.length>200)throw new CommandValidationError('Acceptance page exceeds bound.');for(const row of page){if(row.id<=after||!Number.isSafeInteger(row.row_revision)||row.row_revision<1)throw new ModuleConflictError('Invalid owner row order or revision.');after=row.id;bytes+=new TextEncoder().encode(row.payload_json).length;if(++count>10000||bytes>8_000_000)throw new CommandValidationError('Acceptance context exceeds read bound.');if(await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new ModuleConflictError('Acceptance row hash differs.');rows.push(row);snapshot.rows.push({module:table,id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,references:[]});}if(page.length<200)break;}tables.set(table,rows);}
 snapshot.digest=await contentHash(canonical({coveredModules:snapshot.coveredModules,rows:snapshot.rows}));return {tables,snapshot};
}
async function prepare(ctx:PrepareContext):Promise<MutationPlan>{
 const command=acceptanceCommandSchema.parse(ctx.command);const loaded=await load(ctx);const plan:MutationPlan={planningAfter:ctx.before.workspace,writes:[],events:[],jobs:[],referenceSnapshot:loaded.snapshot};
 const rows=(table:RegisteredOwnerTable)=>loaded.tables.get(table)!;
 function typed<T extends {id:string}>(table:RegisteredOwnerTable,schema:z.ZodType<T>){return rows(table).map(row=>{const value=schema.parse(JSON.parse(row.payload_json));if(value.id!==row.id)throw new ModuleConflictError('Owner record identity differs.');return value;});}
 const requirements=typed('evidence_requirements',evidenceRequirementSchema);
 let id:string,table:RegisteredOwnerTable,value:JsonValue,previous:JsonValue|null=null,revision:number|null=null;
 if(command.type==='acceptance.record'){
  const input=command.value;if(!subjectExists(ctx,input.subject))throw new CommandValidationError('Acceptance subject is unavailable.');
  const heads=typed('evidence_records',evidenceHeadSchema),links=typed('evidence_links',evidenceLinkSchema),priorAcceptances=typed('acceptance_records',acceptanceRecordSchema),decisionHeads=typed('decision_records',evidenceHeadSchema);
  const evidence=await Promise.all(rows('evidence_versions').map(async row=>{const value=evidenceVersionSchema.parse(JSON.parse(row.payload_json));if(row.id!==await versionRowId(value.id,value.version))throw new ModuleConflictError('Evidence version identity differs.');return value;}));
  const trustedDecisionVersions:DecisionVersion[]=[];
  for(const row of rows('decision_versions')){const decision=decisionVersionSchema.parse(JSON.parse(row.payload_json));if(row.id!==await versionRowId(decision.id,decision.version))throw new ModuleConflictError('Decision version identity differs.');if(ctx.trustedDecisionVersion&&await ctx.trustedDecisionVersion(decision.id,decision.version,row.content_hash))trustedDecisionVersions.push(decision);}
  const attachments:VerifiedAttachment[]=[];const selectedIds=new Set(input.evidenceRefs.flatMap(ref=>evidence.filter(e=>e.id===ref.id&&e.version===ref.version).flatMap(e=>e.attachmentIds)));
  for(const record of typed('attachments',attachmentRecordSchema)){if(record.status!=='ready'||!selectedIds.has(record.id)||!ctx.verifyAttachment)continue;const proof=await ctx.verifyAttachment(record);if(proof&&canonical(proof.record)===canonical(record))attachments.push(proof);}
  id=crypto.randomUUID();table='acceptance_records';const candidate={...input,id,recordedAt:ctx.now};const preview=await previewAcceptance(candidate,{trustedOrigin:'owner',subject:input.subject,candidate:input.candidate,asOf:ctx.now,requirements,evidence,heads,links,attachments,trustedDecisionVersions,trustedDecisionHeads:decisionHeads,priorAcceptances});
  if(!preview.canRecord||!preview.record)throw new CommandValidationError(preview.errors.join('; ')||'Acceptance cannot be recorded.');
  plan.decisionGrants=input.exceptions.map(exception=>{const row=rows('decision_versions').find(row=>{const record=JSON.parse(row.payload_json);return record.id===exception.decisionId&&record.version===exception.decisionVersion;});if(!row)throw new CommandValidationError('Decision grant is unavailable.');return {id:exception.decisionId,version:exception.decisionVersion,hash:row.content_hash};});value=preview.record as unknown as JsonValue;
 }else{
  table='evidence_requirements';id=command.type==='evidence.requirement.create'?crypto.randomUUID():command.id;
  const row=rows(table).find(row=>row.id===id);const prior=requirements.find(requirement=>requirement.id===id);
  if(command.type!=='evidence.requirement.create'){if(!row||!prior)throw new CommandValidationError('Requirement is unavailable.');if(row.row_revision!==command.expectedRowRevision)throw new ModuleConflictError('Requirement revision changed.');previous=prior as unknown as JsonValue;revision=row.row_revision;}
  if(command.type==='evidence.requirement.create'||command.type==='evidence.requirement.revise'){
   if(!subjectExists(ctx,command.value.subject))throw new CommandValidationError('Requirement subject is unavailable.');if(prior&&(prior.archivedAt!==null||!sameSubject(prior.subject,command.value.subject)))throw new CommandValidationError('Restore archived criteria before revision; criteria cannot move subjects.');
   if(requirements.filter(r=>sameSubject(r.subject,command.value.subject)&&r.archivedAt===null&&r.id!==id).length>=200)throw new CommandValidationError('Subject criterion limit reached.');value=evidenceRequirementSchema.parse({...command.value,id,archivedAt:null}) as unknown as JsonValue;
  }else{if(!subjectExists(ctx,prior!.subject))throw new CommandValidationError('Requirement subject is unavailable.');if(command.type==='evidence.requirement.restore'&&requirements.filter(r=>sameSubject(r.subject,prior!.subject)&&r.archivedAt===null&&r.id!==id).length>=200)throw new CommandValidationError('Subject criterion limit reached.');value={...prior!,archivedAt:command.type==='evidence.requirement.archive'?prior!.archivedAt??ctx.now:null} as unknown as JsonValue;}
 }
 plan.writes.push({table,id,value,operation:revision===null?'insert':'update',expectedRowRevision:revision});
 plan.events.push(parseAuditEvent({id:crypto.randomUUID(),kind:command.type,entityType:table==='acceptance_records'?'acceptance':'evidence-requirement',entityId:id,changes:[{path:['record'],before:{exists:previous!==null,value:previous},after:{exists:true,value}}],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:null,undoOf:null}));return plan;
}
const handler:CommandHandler={async prepare(ctx){try{return await prepare(ctx);}catch(error){if(error instanceof CommandValidationError||error instanceof ModuleConflictError)throw error;throw new CommandValidationError(error instanceof Error?error.message:'Invalid acceptance command.');}}};
export const acceptanceCommandHandlers:ReadonlyMap<string,CommandHandler>=new Map(['evidence.requirement.create','evidence.requirement.revise','evidence.requirement.archive','evidence.requirement.restore','acceptance.record'].map(type=>[type,handler]));
