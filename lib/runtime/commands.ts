import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {parseAuditEvent} from '../audit-events.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {deviceDisplaySchema,deviceIdSchema,deviceEnrollmentScopesSchema,enrollmentInputSchema,opaqueRuntimeAliasSchema} from '../devices/validation.ts';
import {DEVICE_LIMITS} from '../devices/contracts.ts';
import {RUNTIME_LIMITS,type SelectedRuntimeEvidence} from './contracts.ts';
import {runtimeAdapterConfigurationSchema,runtimeObservationSchema,runtimeSourceSchema,selectedRuntimeEvidenceSchema} from './validation.ts';
import type {CommandHandler,PrepareContext,MutationPlan} from '../workspace-transaction.ts';
import type {ModuleRow,RegisteredOwnerTable} from '../workspace-modules.ts';
import type {JsonValue} from '../workspace-protocol.ts';
const positive=z.number().int().positive().safe(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const enrollmentMaterialSchema=z.object({id:deviceIdSchema,deviceId:deviceIdSchema,secretHash:hash,expiresAt:evidenceDateSchema,scopes:deviceEnrollmentScopesSchema}).strict();
export const enrollmentCommandSchema=z.object({type:z.literal('devices.enrollment.create'),value:enrollmentInputSchema.extend({deviceId:deviceIdSchema.optional()}).strict()}).strict();
export const revokeDeviceCommandSchema=z.object({type:z.literal('devices.revoke'),id:deviceIdSchema,expectedRowRevision:positive}).strict();
export const configureAdapterCommandSchema=z.object({type:z.literal('runtime.adapter.configure'),id:deviceIdSchema.optional(),expectedRowRevision:positive.optional(),value:runtimeAdapterConfigurationSchema.omit({id:true})}).strict().refine(v=>(v.id===undefined)===(v.expectedRowRevision===undefined),'An update requires its exact row revision.');
export const selectRuntimeEvidenceCommandSchema=z.object({type:z.literal('runtime.evidence.select'),deviceId:deviceIdSchema,source:runtimeSourceSchema,instanceId:opaqueRuntimeAliasSchema,expectedPayloadHash:hash,expectedHeartbeatHash:hash}).strict();
export type RuntimeEvidenceProof=Omit<SelectedRuntimeEvidence,'id'|'origin'>;
function empty(context:PrepareContext):MutationPlan{return {planningAfter:structuredClone(context.before.workspace),writes:[],preconditions:[],events:[],jobs:[]};}
async function checkedRow(context:PrepareContext,table:RegisteredOwnerTable,id:string):Promise<ModuleRow>{
 const row=await context.query.get(table,id);if(!row||row.id!==id||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('The exact owner record is unavailable.');return row;
}
async function boundedRows(context:PrepareContext,table:RegisteredOwnerTable,limit:number):Promise<ModuleRow[]>{
 const all:ModuleRow[]=[];let after='';for(;;){const rows=await context.query.list(table,{after,limit:Math.min(200,limit+1)});for(const row of rows){if(row.id<=after)throw new Error('Invalid owner pagination.');after=row.id;all.push(row);if(all.length>limit)throw new Error('Runtime record capacity reached.');}if(rows.length<Math.min(200,limit+1))break;}return all;
}
async function device(context:PrepareContext,plan:MutationPlan,id:string){
 const row=await checkedRow(context,'devices',id),value=deviceDisplaySchema.parse(JSON.parse(row.payload_json));if(value.id!==id||value.archivedAt)throw new Error('Select an active owner device.');plan.preconditions!.push({table:'devices',id,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});return {row,value};
}
function audit(context:PrepareContext,plan:MutationPlan,kind:string,entityType:string,id:string,before:JsonValue|null,after:JsonValue|null,path:string[]){
 plan.events.push(parseAuditEvent({id:crypto.randomUUID(),kind,entityType,entityId:id,changes:[{path,before:{exists:before!==null,value:before},after:{exists:after!==null,value:after}}],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}));
}
export const enrollmentCommandHandler:CommandHandler={async prepare(context){
 const command=enrollmentCommandSchema.parse(context.command),material=enrollmentMaterialSchema.parse(context.deviceRuntime?.enrollment);evidenceDateSchema.parse(context.now);
 if(Date.parse(material.expiresAt)<=Date.parse(context.now)||Date.parse(material.expiresAt)-Date.parse(context.now)>DEVICE_LIMITS.enrollmentMs)throw new Error('Enrollment material has expired.');
 if(canonical(command.value.scopes)!==canonical(material.scopes)||command.value.deviceId!==undefined&&command.value.deviceId!==material.deviceId)throw new Error('Enrollment material does not match the reviewed device.');
 const plan=empty(context);
 if(command.value.deviceId!==undefined){const prior=await device(context,plan,command.value.deviceId);if(prior.value.label!==command.value.label)throw new Error('Re-enrollment requires the exact existing device label.');}
 else{
  const rows=await boundedRows(context,'devices',DEVICE_LIMITS.devices);if(rows.length>=DEVICE_LIMITS.devices)throw new Error('Device capacity reached.');
  if(await context.query.get('devices',material.deviceId))throw new Error('Device identity is already in use.');
  const value=deviceDisplaySchema.parse({id:material.deviceId,label:command.value.label,createdAt:context.now,archivedAt:null});
  plan.writes.push({table:'devices',id:value.id,operation:'insert',expectedRowRevision:null,value:value as unknown as JsonValue});
 }
 plan.deviceControls={enrollment:material};
 // The enrollment digest and plaintext never enter the immutable public ledger.
 audit(context,plan,command.type,'device',material.deviceId,null,{deviceId:material.deviceId,label:command.value.label,expiresAt:material.expiresAt,scopes:material.scopes},['device-enrollment',material.deviceId]);
 return plan;
}};
export const revokeDeviceCommandHandler:CommandHandler={async prepare(context){
 const command=revokeDeviceCommandSchema.parse(context.command),plan=empty(context),prior=await device(context,plan,command.id);if(prior.row.row_revision!==command.expectedRowRevision)throw new Error('The device display changed.');
 plan.deviceControls={revokeIds:[command.id]};audit(context,plan,command.type,'device',command.id,null,{deviceId:command.id,revokedAt:context.now},['device-revocation',command.id]);return plan;
}};
export const configureAdapterCommandHandler:CommandHandler={async prepare(context){
 const command=configureAdapterCommandSchema.parse(context.command),plan=empty(context);await device(context,plan,command.value.deviceId);
 if(command.value.projectId!==null){const project=context.before.workspace.projects.find(row=>row.id===command.value.projectId);if(!project||project.archivedAt)throw new Error('Select an active owner project.');}
 if(command.value.manifest.endpointAlias!==command.value.manifest.id)throw new Error('Select a registered fixed runtime endpoint.');
 if(command.value.manifest.id!=='pc-command-center'&&command.value.selectedGpuAlias!==null)throw new Error('GPU selection is only supported for PC telemetry.');
 if(command.value.manifest.enabled&&(canonical([...command.value.manifest.capabilities].sort())!==canonical(['read.health','read.summary'])))throw new Error('Enabled PC telemetry requires its exact read-only capabilities.');
 const rows=await boundedRows(context,'runtime_adapter_configurations',RUNTIME_LIMITS.adapterConfigurations);
 let prior:ModuleRow|null=null;if(command.id){prior=await checkedRow(context,'runtime_adapter_configurations',command.id);if(prior.row_revision!==command.expectedRowRevision)throw new Error('The adapter configuration changed.');}
 else if(rows.length>=RUNTIME_LIMITS.adapterConfigurations)throw new Error('Adapter capacity reached.');
 const id=command.id??crypto.randomUUID(),value=runtimeAdapterConfigurationSchema.parse({...command.value,id});
 for(const row of rows){if(row.id===id)continue;const other=runtimeAdapterConfigurationSchema.parse(JSON.parse(row.payload_json));if(other.deviceId===value.deviceId&&other.manifest.id===value.manifest.id&&other.manifest.endpointAlias===value.manifest.endpointAlias)throw new Error('This device already has that runtime adapter.');}
 plan.writes.push({table:'runtime_adapter_configurations',id,operation:prior?'update':'insert',expectedRowRevision:prior?.row_revision??null,value:value as unknown as JsonValue});
 if(prior)plan.preconditions!.push({table:'runtime_adapter_configurations',id,expectedRowRevision:prior.row_revision,expectedHash:prior.content_hash});
 audit(context,plan,command.type,'runtime-adapter',id,prior?JSON.parse(prior.payload_json):null,value as unknown as JsonValue,['runtime_adapter_configurations',id]);return plan;
}};
export const selectRuntimeEvidenceCommandHandler:CommandHandler={async prepare(context){
 const command=selectRuntimeEvidenceCommandSchema.parse(context.command),plan=empty(context);await device(context,plan,command.deviceId);
 if(command.source!=='pc-command-center'||!context.deviceRuntime?.latest)throw new Error('This runtime evidence source is unavailable.');
 const raw=await context.deviceRuntime.latest({deviceId:command.deviceId,source:command.source,instanceId:command.instanceId});if(!raw)throw new Error('The exact current runtime observation is unavailable.');
 const id=crypto.randomUUID(),value=selectedRuntimeEvidenceSchema.parse({...raw,id,origin:'native-device'});
 if(value.deviceId!==command.deviceId||value.source!==command.source||value.instanceId!==command.instanceId||value.payloadHash!==command.expectedPayloadHash||value.heartbeatRef.hash!==command.expectedHeartbeatHash||await contentHash(canonical(runtimeObservationSchema.parse(value.observation)))!==value.payloadHash||Date.parse(value.receivedAt)>Date.parse(context.now))throw new Error('The reviewed runtime observation changed.');
 const rows=await boundedRows(context,'runtime_evidence',RUNTIME_LIMITS.selectedEvidence);if(rows.length>=RUNTIME_LIMITS.selectedEvidence)throw new Error('Selected runtime evidence capacity reached.');
 const {id:ignoredId,origin:ignoredOrigin,...proof}=value;void ignoredId;void ignoredOrigin;
 plan.writes.push({table:'runtime_evidence',id,operation:'insert',expectedRowRevision:null,value:value as unknown as JsonValue});plan.deviceControls={evidenceProofs:[proof]};
 audit(context,plan,command.type,'runtime-evidence',id,null,value as unknown as JsonValue,['runtime_evidence',id]);return plan;
}};
export const deviceRuntimeHandlers=new Map<string,CommandHandler>([['devices.enrollment.create',enrollmentCommandHandler],['devices.revoke',revokeDeviceCommandHandler],['runtime.adapter.configure',configureAdapterCommandHandler],['runtime.evidence.select',selectRuntimeEvidenceCommandHandler]]);
