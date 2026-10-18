import {z} from 'zod';
import type {CommandHandler,PrepareContext,MutationPlan} from './workspace-transaction.ts';
import type {RegisteredOwnerTable,ModuleRow} from './workspace-modules.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {CommandValidationError,ModuleConflictError} from './workspace-errors.ts';
import {parseAuditEvent} from './audit-events.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {versionRowId} from './version-identity.ts';
import {evidenceIdSchema,evidenceInputSchema,evidenceHeadSchema,evidenceVersionSchema,evidenceLinkSchema,evidenceLinkInputSchema,evidenceSubjectSchema} from './evidence-validation.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {evidenceRequirementSchema,sameSubject} from './evidence-requirements.ts';
import {legacyEvidenceId,legacyEvidenceMappingSchema,prepareLegacyEvidenceMigration} from './evidence-migration.ts';
import type {EvidenceSubject,EvidenceVersion} from './evidence-contract.ts';
const commandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('evidence.create'),value:evidenceInputSchema}).strict(),
 z.object({type:z.literal('evidence.revise'),id:evidenceIdSchema,expectedVersion:z.number().int().positive().safe(),value:evidenceInputSchema}).strict(),
 ...(['evidence.archive','evidence.restore','evidence.unlink'] as const).map(type=>z.object({type:z.literal(type),id:evidenceIdSchema}).strict()),
 z.object({type:z.literal('evidence.link'),value:evidenceLinkInputSchema}).strict(),
 z.object({type:z.literal('evidence.migrate-legacy'),subject:evidenceSubjectSchema}).strict(),
]);
function subjectExists(context:PrepareContext,subject:EvidenceSubject):boolean {
 const w=context.before.workspace;const rows=subject.type==='project'?w.projects:subject.type==='milestone'?w.milestones:subject.type==='task'?w.tasks:w.captures;
 return rows.some(row=>row.id===subject.id);
}
async function prepare(context:PrepareContext):Promise<MutationPlan>{
 const parsed=commandSchema.safeParse(context.command);if(!parsed.success)throw new CommandValidationError('Invalid evidence command.');const command=parsed.data;
 const plan:MutationPlan={planningAfter:context.before.workspace,writes:[],preconditions:[],events:[],jobs:[]};
 const seen=new Map<string,ModuleRow>();
 async function read(table:RegisteredOwnerTable,id:string){const row=await context.query.get(table,id);if(row)await remember(table,row);return row;}
 async function remember(table:RegisteredOwnerTable,row:ModuleRow){
  if(row.content_hash!==await contentHash(canonical(JSON.parse(row.payload_json))))throw new ModuleConflictError('Evidence content hash mismatch.');
  const key=`${table}:${row.id}`;if(!seen.has(key)){seen.set(key,row);plan.preconditions!.push({table,id:row.id,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});}
 }
 async function list(table:RegisteredOwnerTable){const all:ModuleRow[]=[];let after:string|undefined;while(true){const rows=await context.query.list(table,{after,limit:200});if(!rows.length)break;for(const row of rows){if(after!==undefined&&row.id<=after)throw new ModuleConflictError('Invalid evidence page order.');await remember(table,row);all.push(row);after=row.id;if(all.length>10_000)throw new CommandValidationError('Evidence scan limit exceeded.');}if(rows.length<200)break;}return all;}
 function decode<T>(schema:z.ZodType<T>,row:ModuleRow|null):T {if(!row)throw new CommandValidationError('Record is missing or unavailable.');const result=schema.safeParse(JSON.parse(row.payload_json));if(!result.success)throw new CommandValidationError('Record is not typed evidence.');return result.data;}
 function write(table:RegisteredOwnerTable,id:string,value:unknown,row:ModuleRow|null){plan.writes.push({table,id,operation:row?'update':'insert',value:value as JsonValue,expectedRowRevision:row?.row_revision??null});}
 async function activeCapacity(){const rows=await list('evidence_records');let active=0;for(const row of rows){const head=decode(evidenceHeadSchema,row);if(head.id!==row.id)throw new ModuleConflictError('Evidence identity mismatch.');if(head.archivedAt===null)active++;}if(active>=10_000)throw new CommandValidationError('Active evidence limit reached.');}
 async function attachments(version:EvidenceVersion){for(const id of version.attachmentIds){const attachment=decode(attachmentRecordSchema,await read('attachments',id));if(attachment.id!==id||attachment.status!=='ready')throw new CommandValidationError('Attachment is missing or not ready.');}}
 async function append(id:string,value:unknown,current:number,row:ModuleRow|null){const version=evidenceVersionSchema.parse({...value as object,id,version:current+1,recordedAt:context.now,supersedesVersion:current||null});await attachments(version);const physical=await versionRowId(id,version.version);if(await read('evidence_versions',physical))throw new ModuleConflictError('Evidence version already exists.');write('evidence_records',id,{id,currentVersion:version.version,archivedAt:null},row);write('evidence_versions',physical,version,null);}
 async function head(id:string){const row=await read('evidence_records',id);const value=decode(evidenceHeadSchema,row);if(value.id!==id)throw new ModuleConflictError('Evidence identity mismatch.');return {row,value};}
 let entityId:string|null=null;
 if(command.type==='evidence.create'){await activeCapacity();entityId=crypto.randomUUID();await append(entityId,command.value,0,null);}
 else if(command.type==='evidence.revise'){entityId=command.id;const h=await head(command.id);if(h.value.currentVersion!==command.expectedVersion)throw new ModuleConflictError('Evidence version changed.');if(h.value.archivedAt)throw new CommandValidationError('Restore archived evidence before revising.');const previous=decode(evidenceVersionSchema,await read('evidence_versions',await versionRowId(command.id,h.value.currentVersion)));if(previous.id!==command.id||previous.version!==h.value.currentVersion)throw new ModuleConflictError('Evidence identity mismatch.');await append(command.id,command.value,h.value.currentVersion,h.row);}
 else if(command.type==='evidence.archive'||command.type==='evidence.restore'){entityId=command.id;const h=await head(command.id);if(command.type==='evidence.restore'&&h.value.archivedAt!==null)await activeCapacity();write('evidence_records',command.id,{...h.value,archivedAt:command.type==='evidence.archive'?h.value.archivedAt??context.now:null},h.row);}
 else if(command.type==='evidence.link'){
  const value=command.value;entityId=value.evidenceId;if(!subjectExists(context,value.subject))throw new CommandValidationError('Subject is missing or unavailable.');const h=await head(value.evidenceId);if(h.value.archivedAt||value.evidenceVersion>h.value.currentVersion)throw new CommandValidationError('Evidence version is unavailable.');const version=decode(evidenceVersionSchema,await read('evidence_versions',await versionRowId(value.evidenceId,value.evidenceVersion)));if(version.id!==value.evidenceId||version.version!==value.evidenceVersion)throw new ModuleConflictError('Evidence identity mismatch.');
  if(value.requirementId){const requirement=decode(evidenceRequirementSchema,await read('evidence_requirements',value.requirementId));if(requirement.id!==value.requirementId||requirement.archivedAt||!sameSubject(requirement.subject,value.subject))throw new CommandValidationError('Requirement does not belong to this subject.');}
  const links=(await list('evidence_links')).map(row=>decode(evidenceLinkSchema,row));if(links.filter(link=>sameSubject(link.subject,value.subject)).length>=200)throw new CommandValidationError('Subject evidence link limit reached.');if(links.some(link=>canonical({...link,id:undefined})===canonical({...value,id:undefined})))throw new CommandValidationError('Evidence is already linked.');const id=crypto.randomUUID();write('evidence_links',id,{...value,id},null);
 }else if(command.type==='evidence.unlink'){const row=await read('evidence_links',command.id);const link=decode(evidenceLinkSchema,row);if(link.id!==command.id)throw new ModuleConflictError('Evidence link identity mismatch.');entityId=link.evidenceId;plan.writes.push({table:'evidence_links',id:command.id,operation:'delete',expectedRowRevision:row!.row_revision});}
 else if(command.type==='evidence.migrate-legacy'){
  if(!subjectExists(context,command.subject))throw new CommandValidationError('Legacy subject is unavailable.');const id=await legacyEvidenceId(command.subject);entityId=id;const mappingRow=await read('evidence_mappings',id);const mapping=mappingRow?decode(legacyEvidenceMappingSchema,mappingRow):undefined;const row=await read('evidence_records',id);const h=row?decode(evidenceHeadSchema,row):null;if(h&&(h.id!==id||h.archivedAt))throw new CommandValidationError('Legacy evidence is archived or unavailable.');
  if(mapping&&!h)throw new ModuleConflictError('Legacy evidence head is unavailable.');if(h){const previous=decode(evidenceVersionSchema,await read('evidence_versions',await versionRowId(id,h.currentVersion)));if(previous.id!==id||previous.version!==h.currentVersion)throw new ModuleConflictError('Legacy evidence version is unavailable.');}
  const migration=await prepareLegacyEvidenceMigration(context.before.workspace,command.subject,context.now,mapping,h?.currentVersion??0);if(migration&&migration.status!=='unchanged'){if(!h)await activeCapacity();await append(id,migration.version!,h?.currentVersion??0,row);write('evidence_mappings',id,migration.mapping,mappingRow);}
 }
 if(plan.writes.length)plan.events.push(parseAuditEvent({id:crypto.randomUUID(),kind:command.type,entityType:'evidence',entityId,changes:plan.writes.map(write=>{const prior=seen.get(`${write.table}:${write.id}`);return {path:[write.table,write.id],before:{exists:!!prior,value:prior?JSON.parse(prior.payload_json):null},after:{exists:write.operation!=='delete',value:write.value??null}};}),origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}));
 return plan;
}
const handler:CommandHandler={async prepare(context){try{return await prepare(context);}catch(error){if(error instanceof CommandValidationError||error instanceof ModuleConflictError)throw error;throw new CommandValidationError(error instanceof Error?error.message:'Invalid evidence command.');}}};
export const evidenceCommandHandlers:ReadonlyMap<string,CommandHandler>=new Map(['evidence.create','evidence.revise','evidence.archive','evidence.restore','evidence.link','evidence.unlink','evidence.migrate-legacy'].map(type=>[type,handler]));
