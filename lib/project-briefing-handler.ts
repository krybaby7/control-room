import {z} from 'zod';
import {validateProjectBriefing,PROJECT_BRIEFING_MARKER,PROJECT_BRIEFING_MAX_CHARACTERS} from '../shared/project-briefing.mjs';
import {canonical,contentHash} from './canonical-json.ts';
import {parseAuditEvent} from './audit-events.ts';
import {CommandValidationError,ModuleConflictError} from './workspace-errors.ts';
import type {CommandHandler,PrepareContext,MutationPlan} from './workspace-transaction.ts';
import type {RegisteredOwnerTable,ModuleRow} from './workspace-modules.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {evidenceIdSchema,evidenceHeadSchema,evidenceVersionSchema,evidenceLinkSchema} from './evidence-validation.ts';
import {versionRowId} from './version-identity.ts';
export {PROJECT_BRIEFING_MARKER};
const schema=z.object({type:z.literal('project-briefing.save'),projectId:evidenceIdSchema,evidenceId:evidenceIdSchema.optional(),expectedVersion:z.number().int().positive().safe().optional(),briefing:z.unknown()}).strict();
/** A saved briefing is immutable owner-private evidence linked to its project as context. One
 * active briefing exists per project; refreshing it appends a version. */
async function prepare(context:PrepareContext):Promise<MutationPlan>{
 const command=schema.parse(context.command),briefing=validateProjectBriefing(command.briefing);
 if(Boolean(command.evidenceId)!==(command.expectedVersion!==undefined))throw new CommandValidationError('Refreshing a briefing requires its evidence ID and expected version.');
 if(new TextEncoder().encode(JSON.stringify(context.command)).length>=65536||JSON.stringify(briefing).length>PROJECT_BRIEFING_MAX_CHARACTERS)throw new CommandValidationError('Project briefing exceeds its size limit.');
 const project=context.before.workspace.projects.find(project=>project.id===command.projectId);if(!project||project.archivedAt!==null)throw new CommandValidationError('Choose an active project.');
 if(briefing.project.id!==command.projectId)throw new CommandValidationError('Briefing belongs to another project.');
 const plan:MutationPlan={planningAfter:context.before.workspace,writes:[],preconditions:[],events:[],jobs:[]},seen=new Map<string,ModuleRow>();
 async function remember(table:RegisteredOwnerTable,row:ModuleRow){if(row.content_hash!==await contentHash(canonical(JSON.parse(row.payload_json))))throw new ModuleConflictError('Evidence content hash mismatch.');const key=table+':'+row.id;if(!seen.has(key)){seen.set(key,row);plan.preconditions!.push({table,id:row.id,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});}return row;}
 async function read(table:RegisteredOwnerTable,id:string){const row=await context.query.get(table,id);return row?remember(table,row):null;}
 async function list(table:RegisteredOwnerTable){const result:ModuleRow[]=[];let after='';let bytes=0;for(;;){const page=await context.query.list(table,{after,limit:200});for(const row of page){if(row.id<=after)throw new ModuleConflictError('Invalid evidence order.');after=row.id;bytes+=row.payload_json.length;if(result.length>=10000||bytes>8_000_000)throw new CommandValidationError('Project briefing read limit reached.');result.push(await remember(table,row));}if(page.length<200)break;}return result;}
 const heads=await list('evidence_records'),links=(await list('evidence_links')).map(row=>{const value=evidenceLinkSchema.parse(JSON.parse(row.payload_json));if(value.id!==row.id)throw new ModuleConflictError('Evidence link identity differs.');return value;});
 const versions=await list('evidence_versions');const briefingVersions=new Map<string,ReturnType<typeof validateProjectBriefing>>();
 for(const row of versions){const value=evidenceVersionSchema.parse(JSON.parse(row.payload_json));if(await versionRowId(value.id,value.version)!==row.id)throw new ModuleConflictError('Evidence version identity differs.');if(value.sourceRecordId===PROJECT_BRIEFING_MARKER){const previous=validateProjectBriefing(JSON.parse(value.statement));if(previous.run.id===briefing.run.id)throw new CommandValidationError('This briefing run was already saved.');briefingVersions.set(row.id,previous);}}
 if(links.filter(link=>link.subject.type==='project'&&link.subject.id===command.projectId).length>=200)throw new CommandValidationError('Project evidence link limit reached.');
 const id=command.evidenceId??crypto.randomUUID();let current=0;let prior:ModuleRow|null=null;
 if(command.evidenceId){prior=await read('evidence_records',id);if(!prior)throw new CommandValidationError('Briefing is unavailable.');const head=evidenceHeadSchema.parse(JSON.parse(prior.payload_json));if(head.id!==id||head.archivedAt!==null||head.currentVersion!==command.expectedVersion)throw new ModuleConflictError('Briefing version changed or is archived.');current=head.currentVersion;const previous=await read('evidence_versions',await versionRowId(id,current));if(!previous)throw new CommandValidationError('Briefing version is unavailable.');const version=evidenceVersionSchema.parse(JSON.parse(previous.payload_json));if(version.id!==id||version.version!==current||version.sourceRecordId!==PROJECT_BRIEFING_MARKER)throw new CommandValidationError('Evidence is not a project briefing.');const parsed=validateProjectBriefing(JSON.parse(version.statement));if(parsed.project.id!==briefing.project.id)throw new CommandValidationError('Briefing belongs to another project.');const ownLinks=links.filter(link=>link.evidenceId===id);if(!ownLinks.some(link=>link.evidenceVersion===current&&link.subject.type==='project'&&link.subject.id===command.projectId&&link.relation==='context')||ownLinks.some(link=>link.subject.type!=='project'||link.subject.id!==command.projectId))throw new CommandValidationError('Briefing belongs to another project.');
 }else{
  let active=0;
  for(const row of heads){const head=evidenceHeadSchema.parse(JSON.parse(row.payload_json));if(head.id!==row.id)throw new ModuleConflictError('Evidence head identity differs.');if(head.archivedAt!==null)continue;active++;
   const linked=links.some(link=>link.evidenceId===head.id&&link.evidenceVersion===head.currentVersion&&link.subject.type==='project'&&link.subject.id===command.projectId&&link.relation==='context');
   const existing=linked?briefingVersions.get(await versionRowId(head.id,head.currentVersion)):undefined;
   if(existing)throw new CommandValidationError('Refreshing a briefing requires its evidence ID and expected version.');}
  if(active>=10000)throw new CommandValidationError('Active evidence limit reached.');
 }
 // Consolidate legacy per-folder heads when the project ledger is refreshed.
 for(const row of heads){const head=evidenceHeadSchema.parse(JSON.parse(row.payload_json));if(head.id===id||head.archivedAt!==null)continue;const linked=links.some(link=>link.evidenceId===head.id&&link.evidenceVersion===head.currentVersion&&link.subject.type==='project'&&link.subject.id===command.projectId&&link.relation==='context');if(linked&&briefingVersions.has(await versionRowId(head.id,head.currentVersion)))plan.writes.push({table:'evidence_records',id:head.id,operation:'update',expectedRowRevision:row.row_revision,value:{...head,archivedAt:context.now}});}
 const version=evidenceVersionSchema.parse({id,version:current+1,basis:'documented-result',scope:'implementation',title:`Project briefing · ${briefing.project.name}`.slice(0,200),statement:JSON.stringify(briefing),observedAt:null,recordedAt:context.now,candidate:null,environment:'Uploaded personal PC briefing claim; model identity and factual accuracy are not server verified.',sourceUrl:null,sourceRevision:briefing.repository.head,sourceRecordId:PROJECT_BRIEFING_MARKER,attachmentIds:[],supersedesVersion:current||null}),physical=await versionRowId(id,current+1);
 if(await read('evidence_versions',physical))throw new ModuleConflictError('Briefing version already exists.');
 const linkId=crypto.randomUUID(),link=evidenceLinkSchema.parse({id:linkId,evidenceId:id,evidenceVersion:current+1,subject:{type:'project',id:command.projectId},requirementId:null,relation:'context'});
 plan.writes.push({table:'evidence_records',id,operation:prior?'update':'insert',expectedRowRevision:prior?.row_revision??null,value:{id,currentVersion:current+1,archivedAt:null}},{table:'evidence_versions',id:physical,operation:'insert',expectedRowRevision:null,value:version as unknown as JsonValue},{table:'evidence_links',id:linkId,operation:'insert',expectedRowRevision:null,value:link as unknown as JsonValue});
 plan.events.push(parseAuditEvent({id:crypto.randomUUID(),kind:'project-briefing.save',entityType:'evidence',entityId:id,origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null,changes:plan.writes.map(write=>{const before=seen.get(write.table+':'+write.id);return{path:[write.table,write.id],before:{exists:!!before,value:before?JSON.parse(before.payload_json):null},after:{exists:true,value:write.value}};})}));return plan;
}
const handler:CommandHandler={async prepare(context){try{return await prepare(context);}catch(error){if(error instanceof CommandValidationError||error instanceof ModuleConflictError)throw error;throw new CommandValidationError('Invalid project briefing.');}}};
export const projectBriefingCommandHandlers:ReadonlyMap<string,CommandHandler>=new Map([['project-briefing.save',handler]]);
