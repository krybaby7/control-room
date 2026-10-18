import {z} from 'zod';
import type {ExportContext,ExportModule,ImportContext} from '../workspace-export.ts';
import {assertPortable,boundedPages,BUNDLE_LIMITS} from '../workspace-export-core.ts';
import type {ReferenceDescriptor,TypedReference} from '../workspace-references.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {deviceDisplaySchema,deviceIdSchema} from '../devices/validation.ts';
import {DEVICE_LIMITS} from '../devices/contracts.ts';
import {RUNTIME_LIMITS} from './contracts.ts';
import {runtimeAdapterConfigurationSchema,selectedRuntimeEvidenceSchema} from './validation.ts';
const specs=[
 {key:'devices',schema:deviceDisplaySchema,limit:DEVICE_LIMITS.devices,entityKind:'device'},
 {key:'runtime_adapter_configurations',schema:runtimeAdapterConfigurationSchema,limit:RUNTIME_LIMITS.adapterConfigurations},
 {key:'runtime_evidence',schema:selectedRuntimeEvidenceSchema,limit:RUNTIME_LIMITS.selectedEvidence,entityKind:'runtime-evidence'},
] as const;
type Spec=typeof specs[number];
const wrapper=z.object({id:deviceIdSchema,rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/u),value:z.unknown()}).strict();
function parse(spec:Spec,raw:unknown){
 assertPortable(raw);
 const row=wrapper.parse(raw),value=spec.schema.parse(row.value);
 if(row.id!==value.id||canonical(value)!==canonical(row.value))throw new Error('Runtime portable identity or canonical shape differs.');
 return {...row,value};
}
function rows(spec:Spec,raw:unknown[]){
 if(raw.length>spec.limit)throw new Error('Runtime portable owner row limit exceeded.');
 const parsed=raw.map(value=>parse(spec,value));
 if(new Set(parsed.map(row=>row.id)).size!==parsed.length)throw new Error('Duplicate runtime portable identity.');
 return parsed;
}
async function verify(spec:Spec,raw:unknown){
 const row=parse(spec,raw);
 if(await contentHash(canonical(row.value))!==row.contentHash)throw new Error('Runtime portable record digest differs.');
 if(spec.key==='runtime_evidence'){const value=selectedRuntimeEvidenceSchema.parse(row.value);if(await contentHash(canonical(value.observation))!==value.payloadHash)throw new Error('Selected runtime observation digest differs.');}
 return row;
}
async function exported(spec:Spec,context:ExportContext){
 const stored=await boundedPages(after=>context.query.list(spec.key,{after,limit:BUNDLE_LIMITS.pageSize}));
 const parsed=rows(spec,stored.map(row=>({id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,value:JSON.parse(row.payload_json)})));
 for(const row of parsed)await verify(spec,row);return parsed;
}
/** Device labels and explicitly selected immutable observations only. No raw telemetry,
 * latest projection, credentials, live windows, sessions, grants or leases are covered. */
export const runtimeExportAdapters:ExportModule[]=specs.map(spec=>({
 key:spec.key,tables:[spec.key],schemaVersion:1,policy:'replace',legacyOptional:true,
 exportRows:context=>exported(spec,context),
 parseAndMigrate(input){if(input.schemaVersion!==1)throw new Error('Unknown runtime portable module version.');return rows(spec,input.records);},
 validateReferences:validateRuntimeModuleReferences,
 async prepareReplace(context,input){
  const parsed=rows(spec,input),next={...context,modules:{...context.modules,[spec.key]:{schemaVersion:1,records:parsed}}};
  validateRuntimeModuleReferences(next);
  const records=[];for(const raw of parsed){const row=await verify(spec,raw);
   // Verify the original portable body/hash first; central compilation hashes this
   // explicit disconnected historical projection as the replacement row.
   const value=spec.key==='runtime_adapter_configurations'?(()=>{const v=runtimeAdapterConfigurationSchema.parse(row.value);return {...v,manifest:{...v.manifest,enabled:false}};})():spec.key==='runtime_evidence'?{...selectedRuntimeEvidenceSchema.parse(row.value),origin:'historical-import' as const}:row.value;
   records.push({id:row.id,value:value as unknown as JsonValue});
  }
  return [{table:spec.key,records}];
 },
}));
const ref=(kind:TypedReference['kind'],id:string,path:(string|number)[]):TypedReference=>({kind,id,path});
export const runtimeReferenceDescriptors:ReferenceDescriptor[]=specs.map(spec=>({
 key:spec.key,schemaVersion:1,...('entityKind' in spec?{entityKind:spec.entityKind}:{}),
 parse(value){assertPortable(value);return spec.schema.parse(value);},
 references(value){
  if(spec.key==='devices'){deviceDisplaySchema.parse(value);return [];}
  if(spec.key==='runtime_evidence'){const v=selectedRuntimeEvidenceSchema.parse(value);return [ref('device',v.deviceId,['deviceId'])];}
  const v=runtimeAdapterConfigurationSchema.parse(value);return [ref('device',v.deviceId,['deviceId']),...(v.projectId?[ref('project',v.projectId,['projectId'])]:[])];
 },
}));
export function validateRuntimeModuleReferences(context:ImportContext):void{
 const get=(key:Spec['key'])=>{const spec=specs.find(value=>value.key===key)!;return rows(spec,context.modules[key]?.records??[]).map(row=>row.value);};
 const devices=get('devices').map(value=>deviceDisplaySchema.parse(value)),configurations=get('runtime_adapter_configurations').map(value=>runtimeAdapterConfigurationSchema.parse(value)),evidence=get('runtime_evidence').map(value=>selectedRuntimeEvidenceSchema.parse(value));
 const deviceIds=new Set(devices.map(value=>value.id));
 for(const value of [...configurations,...evidence])if(!deviceIds.has(value.deviceId))throw new Error('Runtime device display is missing.');
 const instances=new Set<string>();for(const value of configurations){
  if(value.projectId!==null&&!context.planning.projects.some(project=>project.id===value.projectId))throw new Error('Runtime configuration project is missing.');
  const key=canonical([value.deviceId,value.manifest.id,value.manifest.endpointAlias]);if(instances.has(key))throw new Error('Duplicate runtime adapter instance.');instances.add(key);
 }
}
