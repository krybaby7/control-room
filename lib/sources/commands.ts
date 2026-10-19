import { z } from 'zod';
import type { CommandHandler, PrepareContext, MutationPlan } from '../workspace-transaction.ts';
import type { ModuleRow, RegisteredOwnerTable } from '../workspace-modules.ts';
import type { JsonValue, AuditEventDraft } from '../workspace-protocol.ts';
import type { SourceConnection, SourceTarget, SourceProposal } from './contracts.ts';
import { SOURCE_LIMITS } from './contracts.ts';
import { sourceConnectionSchema, sourceTargetSchema, sourceProposalSchema, sourceObservationSchema } from './validation.ts';
import { sourceConfigurationHash } from '../background/job-store.ts';
import { canonical, contentHash } from '../canonical-json.ts';
import { canonicalJsonValue, parseAuditEvent } from '../audit-events.ts';
import { evidenceDateSchema, evidenceIdSchema, evidenceVersionSchema } from '../evidence-validation.ts';
import { versionRowId } from '../version-identity.ts';
import { assertProposalFieldsAllowed } from './proposals.ts';
import { applyCommand } from '../planning.ts';
import { applyWorkflowCommand } from '../planning-workflows.ts';
import { parseWorkspaceExport } from '../workspace-validation.ts';
import { CommandValidationError, ModuleConflictError } from '../workspace-errors.ts';
const id=evidenceIdSchema,revision=z.number().int().positive().safe();
const connectionInput=sourceConnectionSchema.omit({id:true,archivedAt:true});
const targetInput=sourceTargetSchema.omit({id:true,selectionVersion:true,archivedAt:true});
const nonempty=(value:object)=>Object.keys(value).length>0;
const json=z.unknown().transform((value,ctx)=>{try{return canonicalJsonValue(value);}catch{ctx.addIssue({code:'custom',message:'Edited values must be plain finite JSON.'});return z.NEVER;}});
const types=['sources.connection.create','sources.connection.update','sources.connection.archive','sources.connection.restore','sources.target.create','sources.target.update','sources.target.archive','sources.target.restore','sources.pause','sources.resume','sources.refresh.request','sources.proposal.decide'] as const;
export const sourceCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('sources.connection.create'),value:connectionInput}).strict(),
 z.object({type:z.literal('sources.connection.update'),id,expectedRowRevision:revision,patch:connectionInput.partial().strict().refine(nonempty)}).strict(),
 z.object({type:z.literal('sources.connection.archive'),id,expectedRowRevision:revision}).strict(),z.object({type:z.literal('sources.connection.restore'),id,expectedRowRevision:revision}).strict(),
 z.object({type:z.literal('sources.target.create'),value:targetInput}).strict(),
 z.object({type:z.literal('sources.target.update'),id,expectedRowRevision:revision,patch:targetInput.partial().strict().refine(nonempty)}).strict(),
 z.object({type:z.literal('sources.target.archive'),id,expectedRowRevision:revision}).strict(),z.object({type:z.literal('sources.target.restore'),id,expectedRowRevision:revision}).strict(),
 z.object({type:z.literal('sources.pause'),id,expectedRowRevision:revision}).strict(),z.object({type:z.literal('sources.resume'),id,expectedRowRevision:revision}).strict(),z.object({type:z.literal('sources.refresh.request'),id,expectedRowRevision:revision,manualImportHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),
 z.object({type:z.literal('sources.proposal.decide'),id,expectedRowRevision:revision,decision:z.enum(['accept','reject','defer']),reason:z.string().trim().min(1).max(8000),selectedFields:z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)).min(1).max(10).refine(value=>new Set(value).size===value.length).optional(),editedValues:json.pipe(z.record(json)).refine(value=>Object.keys(value).length<=10&&new TextEncoder().encode(canonical(value)).length<=SOURCE_LIMITS.payloadBytes).optional()}).strict(),
]).superRefine((value,ctx)=>{if(value.type==='sources.proposal.decide'){if(value.decision==='accept'&&!value.selectedFields)ctx.addIssue({code:'custom',message:'Explicit selected fields are required.'});if(value.decision!=='accept'&&(value.selectedFields!==undefined||value.editedValues!==undefined))ctx.addIssue({code:'custom',message:'Reject and defer cannot carry planning edits.'});}});
export type SourceCommand=z.infer<typeof sourceCommandSchema>;
function providerMatches(connection:SourceConnection,target:SourceTarget){return connection.provider===(target.kind.startsWith('github_')?'github':target.kind==='document'?'documents':'conversation-export');}
function projectLive(context:PrepareContext,target:SourceTarget){const project=context.before.workspace.projects.find(row=>row.id===target.projectId);if(!project||project.archivedAt)throw new CommandValidationError('Select an active owner project.');}
async function prepare(context:PrepareContext):Promise<MutationPlan>{
 const command=sourceCommandSchema.parse(context.command);evidenceDateSchema.parse(context.now);
 const plan:MutationPlan={planningAfter:structuredClone(context.before.workspace),writes:[],preconditions:[],events:[],jobs:[],sourceControls:[],integrationJobs:[]};
 const seen=new Map<string,ModuleRow>();
 async function remember(table:RegisteredOwnerTable,row:ModuleRow){if(!Number.isSafeInteger(row.row_revision)||row.row_revision<1||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new ModuleConflictError('Stored source row hash or revision differs.');const key=`${table}:${row.id}`;if(!seen.has(key)){seen.set(key,row);plan.preconditions!.push({table,id:row.id,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});}return row;}
 async function read(table:RegisteredOwnerTable,key:string){const row=await context.query.get(table,key);if(row&&row.id!==key)throw new ModuleConflictError('Stored source identity differs.');return row?remember(table,row):null;}
 async function required(table:RegisteredOwnerTable,key:string,expected?:number){const row=await read(table,key);if(!row)throw new CommandValidationError('Source record is missing or unavailable for this owner.');if(expected!==undefined&&row.row_revision!==expected)throw new ModuleConflictError('Source row changed; refresh before deciding.');return row;}
 async function list(table:'source_connections'|'source_targets'){let after:string|undefined;const rows:ModuleRow[]=[];for(;;){const page=await context.query.list(table,{after,limit:200});for(const row of page){if(after!==undefined&&row.id<=after)throw new ModuleConflictError('Invalid source pagination order.');after=row.id;rows.push(await remember(table,row));if(rows.length>SOURCE_LIMITS.ownerSources)throw new CommandValidationError('Owner source configuration limit reached.');}if(page.length<200)break;}return rows;}
 function write(table:RegisteredOwnerTable,key:string,value:unknown,row:ModuleRow|null){plan.writes.push({table,id:key,operation:row?'update':'insert',expectedRowRevision:row?.row_revision??null,value:value as JsonValue});}
 function decodeConnection(row:ModuleRow){const value=sourceConnectionSchema.parse(JSON.parse(row.payload_json));if(value.id!==row.id)throw new ModuleConflictError('Connection identity differs.');return value;}
 function decodeTarget(row:ModuleRow){const value=sourceTargetSchema.parse(JSON.parse(row.payload_json));if(value.id!==row.id)throw new ModuleConflictError('Target identity differs.');return value;}
 async function targetConnection(target:SourceTarget,active:boolean){const row=await required('source_connections',target.connectionId),connection=decodeConnection(row);if(!providerMatches(connection,target)||active&&connection.archivedAt!==null)throw new CommandValidationError('Select an active matching provider connection.');return connection;}
 async function pause(connection:SourceConnection,target:SourceTarget){plan.sourceControls!.push({sourceId:target.id,action:'pause',configurationHash:await sourceConfigurationHash(connection,target)});}
 let eventEntityType='source',eventEntityId:string|null='id'in command?command.id:null,eventSource:string|null=null;
 if(command.type==='sources.connection.create'||command.type==='sources.connection.update'||command.type==='sources.connection.archive'||command.type==='sources.connection.restore'){
  let row:ModuleRow|null=null,value:SourceConnection;
  if(command.type==='sources.connection.create'){const rows=await list('source_connections');if(rows.length>=SOURCE_LIMITS.ownerSources)throw new CommandValidationError('Owner source connection limit reached.');value=sourceConnectionSchema.parse({...command.value,id:crypto.randomUUID(),archivedAt:null});}
  else if(command.type==='sources.connection.update'||command.type==='sources.connection.archive'||command.type==='sources.connection.restore'){
   row=await required('source_connections',command.id,command.expectedRowRevision);const before=decodeConnection(row);
   if(command.type==='sources.connection.update'){if(before.archivedAt)throw new CommandValidationError('Restore the connection before editing.');value=sourceConnectionSchema.parse({...before,...command.patch});}
   else value=sourceConnectionSchema.parse({...before,archivedAt:command.type==='sources.connection.archive'?before.archivedAt??context.now:null});
  }else throw new CommandValidationError('Invalid connection command.');
  eventEntityId=value.id;eventEntityType='source-connection';write('source_connections',value.id,value,row);
  for(const targetRow of await list('source_targets')){const target=decodeTarget(targetRow);if(target.connectionId!==value.id)continue;if(!providerMatches(value,target))throw new CommandValidationError('Existing targets require this connection provider. Create a separate connection.');await pause(value,target);}
 }else if(command.type==='sources.target.create'||command.type==='sources.target.update'||command.type==='sources.target.archive'||command.type==='sources.target.restore'){
  let row:ModuleRow|null=null,value:SourceTarget;
  if(command.type==='sources.target.create'){const rows=await list('source_targets');if(rows.length>=SOURCE_LIMITS.ownerSources)throw new CommandValidationError('Owner source target limit reached.');value=sourceTargetSchema.parse({...command.value,id:crypto.randomUUID(),selectionVersion:1,archivedAt:null});}
  else{row=await required('source_targets',command.id,command.expectedRowRevision);const before=decodeTarget(row);
   if(command.type==='sources.target.update'){if(before.archivedAt)throw new CommandValidationError('Restore the source before editing.');const selectionKeys=['connectionId','projectId','kind','providerResourceId','canonicalUrl','selectedPaths']as const;const changed=selectionKeys.some(key=>key in command.patch&&canonical(command.patch[key])!==canonical(before[key]));value=sourceTargetSchema.parse({...before,...command.patch,selectionVersion:before.selectionVersion+(changed?1:0)});}
   else value=sourceTargetSchema.parse({...before,archivedAt:command.type==='sources.target.archive'?before.archivedAt??context.now:null});
  }
  const connection=await targetConnection(value,command.type!=='sources.target.archive');if(command.type!=='sources.target.archive')projectLive(context,value);
  eventEntityId=value.id;write('source_targets',value.id,value,row);await pause(connection,value);
 }else if(command.type==='sources.pause'||command.type==='sources.resume'||command.type==='sources.refresh.request'){
  const row=await required('source_targets',command.id,command.expectedRowRevision),target=decodeTarget(row),connection=await targetConnection(target,command.type!=='sources.pause'),configurationHash=await sourceConfigurationHash(connection,target);
  if(command.type==='sources.pause')await pause(connection,target);
  else{
   projectLive(context,target);if(!connection.enabled||connection.archivedAt||target.archivedAt)throw new CommandValidationError('Enable and restore the selected source and connection first.');
   if(!context.sourceRuntime)throw new CommandValidationError('Verified source runtime access is unavailable.');
   const state=await context.sourceRuntime.state(target.id);if(!state||state.sourceId!==target.id||state.configurationHash!==configurationHash)throw new ModuleConflictError('Source runtime configuration changed.');
   if(command.type==='sources.resume'){if(!await context.sourceRuntime.canResume(connection,target))throw new CommandValidationError('Source access must be verified before explicit resume.');plan.sourceControls!.push({sourceId:target.id,action:'resume',configurationHash});}
   else{if(command.manualImportHash&&(!['document','conversation_export'].includes(target.kind)||connection.accessMode!=='interactive'))throw new CommandValidationError('Manual input binding requires a selected manual source.');if(state.paused)throw new CommandValidationError('Explicitly resume this source before requesting a refresh.');if(!context.mutationId||!/^[A-Za-z0-9_-]{16,128}$/.test(context.mutationId))throw new CommandValidationError('A durable owner mutation ID is required for refresh.');const jobId=`source-refresh-${await contentHash(canonical([context.userId,context.mutationId,target.id,configurationHash]))}`;
    plan.jobs.push({id:jobId,kind:'source_refresh',dedupeKey:jobId,payload:{sourceId:target.id,configurationHash,...(command.manualImportHash?{manualImportHash:command.manualImportHash}:{})},notBefore:context.now});plan.integrationJobs!.push({intentId:jobId,sourceId:target.id,configurationHash});}
  }
 }else{
  const row=await required('source_proposals',command.id,command.expectedRowRevision),proposal=sourceProposalSchema.parse(JSON.parse(row.payload_json));
  if(proposal.id!==row.id||!['pending','deferred'].includes(proposal.state)||proposal.state==='pending'&&proposal.decision!==null)throw new CommandValidationError('Proposal is no longer pending review.');
  assertProposalFieldsAllowed(proposal.entity.kind,proposal.fields);
  const target=decodeTarget(await required('source_targets',proposal.sourceId));await targetConnection(target,false);
  if(new Set(proposal.observationRefs.map(ref=>ref.id)).size!==proposal.observationRefs.length||new Set(proposal.evidenceRefs.map(ref=>`${ref.id}:${ref.version}`)).size!==proposal.evidenceRefs.length)throw new CommandValidationError('Proposal has duplicate immutable references.');
  for(const ref of proposal.observationRefs){const observationRow=await required('source_observations',ref.id),observation=sourceObservationSchema.parse(JSON.parse(observationRow.payload_json));if(observation.id!==ref.id||observation.sourceId!==proposal.sourceId||observation.contentDigest!==ref.contentDigest||await contentHash(canonical(observation.payload))!==ref.contentDigest)throw new ModuleConflictError('Proposal observation provenance differs.');}
  for(const ref of proposal.evidenceRefs){const version=evidenceVersionSchema.parse(JSON.parse((await required('evidence_versions',await versionRowId(ref.id,ref.version))).payload_json));if(version.id!==ref.id||version.version!==ref.version)throw new ModuleConflictError('Proposal evidence version differs.');}
  const selected=command.decision==='accept'?command.selectedFields!:[];
  if(command.decision==='accept'){
   const fields=selected.map(field=>{const value=proposal.fields.find(row=>row.field===field);if(!value)throw new CommandValidationError('Select only fields included in this proposal.');return {...value,after:Object.hasOwn(command.editedValues??{},field)?command.editedValues![field]:value.after};});
   if(Object.keys(command.editedValues??{}).some(field=>!selected.includes(field)))throw new CommandValidationError('Edited values must belong to explicitly selected fields.');
   assertProposalFieldsAllowed(proposal.entity.kind,fields);
   const collection={project:'projects',milestone:'milestones',task:'tasks',capture:'captures'}[proposal.entity.kind]as 'projects'|'milestones'|'tasks'|'captures';
   const before=context.before.workspace[collection].find(entity=>entity.id===proposal.entity.id);if(!before)throw new CommandValidationError('Proposal planning entity is unavailable.');
   const values=before as unknown as Record<string,JsonValue>;for(const field of fields)if(!Object.hasOwn(values,field.field)||canonical(values[field.field])!==canonical(field.before))throw new ModuleConflictError('The selected owner field changed; review a new proposal instead of overwriting it.');
   const patch=Object.fromEntries(fields.map(field=>[field.field,field.after]));
   const changed=proposal.entity.kind==='project'?applyWorkflowCommand(context.before.workspace,{type:'project.edit',id:before.id,patch},{now:context.now,newId:()=>crypto.randomUUID()}).workspace:applyCommand(context.before.workspace,{type:`${proposal.entity.kind}.update`,id:before.id,patch},context.now);
   const after=changed[collection].find(entity=>entity.id===before.id)! as unknown as Record<string,JsonValue>;
   // Ordinary reducers validate the patch; all other owner fields remain exact,
   // including historical lifecycle metadata that an ordinary save may hydrate.
   for(const key of Object.keys(after))if(!selected.includes(key)&&key!=='updatedAt'){if(Object.hasOwn(values,key))after[key]=structuredClone(values[key]);else delete after[key];}
   plan.planningAfter=parseWorkspaceExport(changed,context.now);
   eventEntityType=proposal.entity.kind;eventEntityId=proposal.entity.id;
  }
  const updated:SourceProposal=sourceProposalSchema.parse({...proposal,state:command.decision==='accept'?'accepted':command.decision==='reject'?'rejected':'deferred',decision:{at:context.now,reason:command.reason,selectedFields:selected}});
  write('source_proposals',proposal.id,updated,row);eventSource=`proposal:${proposal.id}`;
 }
 const changes:AuditEventDraft['changes']=plan.writes.map(write=>{const previous=seen.get(`${write.table}:${write.id}`);return {path:[write.table,write.id],before:{exists:!!previous,value:previous?JSON.parse(previous.payload_json)as JsonValue:null},after:{exists:true,value:write.value!}};});
 for(const collection of ['projects','milestones','tasks','captures']as const)for(const after of plan.planningAfter[collection]){const before=context.before.workspace[collection].find(row=>row.id===after.id);if(before&&canonical(before)!==canonical(after))for(const field of new Set([...Object.keys(before),...Object.keys(after)])){const left=before as unknown as Record<string,JsonValue>,right=after as unknown as Record<string,JsonValue>;if(canonical(left[field])!==canonical(right[field]))changes.push({path:[collection,after.id,field],before:{exists:Object.hasOwn(left,field),value:left[field]??null},after:{exists:Object.hasOwn(right,field),value:right[field]??null}});}}
 plan.events.push(parseAuditEvent({id:crypto.randomUUID(),kind:command.type,entityType:eventEntityType,entityId:eventEntityId,changes,origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:eventSource??(eventEntityId?`source:${eventEntityId}`:null),undoOf:null}));
 return plan;
}
const handler:CommandHandler={async prepare(context){try{return await prepare(context);}catch(error){if(error instanceof CommandValidationError||error instanceof ModuleConflictError)throw error;throw new CommandValidationError(error instanceof Error?error.message:'Invalid source command.');}}};
export const sourceCommandHandlers:ReadonlyMap<string,CommandHandler>=new Map(types.map(type=>[type,handler]));
