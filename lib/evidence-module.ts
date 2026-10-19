import {startHashWork} from './hash-work-diagnostics.ts';
import {sourceObservationSchema} from './sources/validation.ts';
import {z} from 'zod';
import type {ExportModule,ImportContext,PhysicalImportRows} from './workspace-export.ts';
import type {ModuleRow,RegisteredOwnerTable} from './workspace-modules.ts';
import type {ReferenceDescriptor,TypedReference} from './workspace-references.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {assertPortable,boundedPages,BUNDLE_LIMITS} from './workspace-export-core.ts';
import {canonical} from './canonical-json.ts';
import {serializationHash,type SerializationHashContext} from './serialization-hash.ts';
import {portableHeadId,versionRowId} from './version-identity.ts';
import {evidenceHeadSchema,evidenceVersionSchema,evidenceLinkSchema,evidenceIdSchema} from './evidence-validation.ts';
import {decisionVersionSchema} from './decisions.ts';
import {evidenceRequirementSchema} from './evidence-requirements.ts';
import {acceptanceRecordSchema} from './acceptance.ts';
import {legacyEvidenceMappingSchema} from './evidence-migration.ts';
import {validateAttachmentMetadata,ATTACHMENT_POLICY} from './attachment-policy.ts';

const id=evidenceIdSchema,stamp=z.string().datetime({offset:true});
export const attachmentRecordSchema=z.object({id,status:z.enum(['reserved','ready','quarantined','deleted']),filename:z.string(),mimeType:z.string(),expectedBytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes),actualBytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes).nullable(),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),storageKey:z.string().min(1).max(500),createdAt:stamp,expiresAt:stamp,readyAt:stamp.nullable(),uploadMutationId:z.string().min(1).max(160),quarantineReason:z.string().max(1000).nullable()}).strict().superRefine((value,ctx)=>{
 try{validateAttachmentMetadata(value);}catch{ctx.addIssue({code:'custom',message:'Invalid attachment metadata.'});}
 if(value.status==='ready'&&(value.actualBytes!==value.expectedBytes||!value.sha256||!value.readyAt))ctx.addIssue({code:'custom',message:'Ready attachment lacks verified metadata.'});
});
const envelopeSchema=z.object({kind:z.enum(['head','version','mapping','legacy']),physicalId:id,record:z.unknown()}).strict();
const wrapperSchema=z.object({id,rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
type Envelope=z.infer<typeof envelopeSchema>;type Wrapper=z.infer<typeof wrapperSchema>;
type Spec={table:RegisteredOwnerTable;kind:Envelope['kind'];parse:(value:unknown)=>unknown;legacy?:boolean;marker?:string};
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function parseOrLegacyInternal(spec:Spec,value:unknown):{kind:Envelope['kind'];record:unknown}{
 assertPortable(value);if(spec.legacy&&(!spec.marker||!object(value)||!Object.hasOwn(value,spec.marker)))return {kind:'legacy',record:value};return {kind:spec.kind,record:spec.parse(value)};
}
function parseOrLegacy(spec:Spec,value:unknown):{kind:Envelope['kind'];record:unknown}{const finish=startHashWork('composite-schema');try{return parseOrLegacyInternal(spec,value);}finally{finish();}}
const evidenceSpecs:Spec[]=[{table:'evidence_records',kind:'head',parse:v=>evidenceHeadSchema.parse(v),legacy:true,marker:'currentVersion'},{table:'evidence_versions',kind:'version',parse:v=>evidenceVersionSchema.parse(v)},{table:'evidence_mappings',kind:'mapping',parse:v=>legacyEvidenceMappingSchema.parse(v)}];
const decisionSpecs:Spec[]=[{table:'decision_records',kind:'head',parse:v=>evidenceHeadSchema.parse(v)},{table:'decision_versions',kind:'version',parse:v=>decisionVersionSchema.parse(v)},{table:'decisions',kind:'legacy',parse:v=>v,legacy:true}];
function specFor(specs:Spec[],value:Envelope):Spec{const spec=specs.find(item=>item.kind===value.kind&&!(value.kind==='legacy'&&item.table==='decision_records'))??(value.kind==='legacy'?specs.find(item=>item.legacy):undefined);if(!spec)throw new Error('Unknown composite record kind.');return spec;}
async function portableId(spec:Spec,kind:Envelope['kind'],physicalId:string,record:unknown,serializationHashContext?:SerializationHashContext):Promise<string>{
 if(kind==='head')return portableHeadId((record as {id:string}).id,serializationHashContext);
 if(kind==='version')return versionRowId((record as {id:string}).id,(record as {version:number}).version,serializationHashContext);
 return `${kind==='mapping'?'m':'l'}:${await serializationHash(canonical([spec.table,physicalId]),serializationHashContext)}`;
}
function parsedCompositeInternal(specs:Spec[],raw:unknown):Wrapper&{value:Envelope}{const row=wrapperSchema.parse(raw),value=envelopeSchema.parse(row.value),spec=specFor(specs,value);assertPortable(value.record);if(value.kind!=='legacy')spec.parse(value.record);else if(!spec.legacy||parseOrLegacy(spec,value.record).kind!=='legacy')throw new Error('Unsupported or downgraded legacy record.');if(value.kind==='head'&&(value.record as {id:string}).id!==value.physicalId)throw new Error('Head physical identity differs.');return {...row,value};}
function parsedComposite(specs:Spec[],raw:unknown):Wrapper&{value:Envelope}{const finish=startHashWork('composite-schema');try{return parsedCompositeInternal(specs,raw);}finally{finish();}}
async function exactIdentity(specs:Spec[],row:Wrapper&{value:Envelope},serializationHashContext?:SerializationHashContext):Promise<void>{const spec=specFor(specs,row.value);if(row.id!==await portableId(spec,row.value.kind,row.value.physicalId,row.value.record,serializationHashContext))throw new Error('Portable composite identity differs.');if(row.value.kind==='version'&&row.value.physicalId!==row.id)throw new Error('Version physical identity differs.');}
/** Per-call ordered pool; every portable identity comparison and schema check
 * runs on every row. Exact SHA digests may be reused only inside an explicit
 * operation-local serialization context. No output escapes before all workers settle. */
async function exportCompositeRows(specs:Spec[],spec:Spec,rows:ModuleRow[],serializationHashContext?:SerializationHashContext):Promise<unknown[]>{
 const result:unknown[]=new Array(rows.length),failure:{index:number;error:unknown}[]=[];let cursor=0;
 async function worker(){for(;;){const index=cursor++;if(index>=rows.length)return;const raw=rows[index];try{
  const {kind,record}=parseOrLegacy(spec,JSON.parse(raw.payload_json)),value={kind,physicalId:raw.id,record};
  const row={id:await portableId(spec,kind,raw.id,record,serializationHashContext),rowRevision:raw.row_revision,contentHash:await serializationHash(canonical(value),serializationHashContext),value};
  const parsed=parsedComposite(specs,row);await exactIdentity(specs,parsed,serializationHashContext);result[index]=row;
 }catch(error){if(!failure.length||index<failure[0].index)failure[0]={index,error};}}}
 await Promise.all(Array.from({length:Math.min(32,rows.length)},()=>worker()));
 if(failure.length)throw failure[0].error;return result;
}
function composite(key:string,specs:Spec[]):ExportModule{return {key,tables:specs.map(item=>item.table),schemaVersion:1,policy:'replace',legacyOptional:true,
 async exportRows(context){const result:unknown[]=[];for(const spec of specs){const rows=await boundedPages(after=>context.query.list(spec.table,{after,limit:BUNDLE_LIMITS.pageSize}));const selected=rows.slice(0,BUNDLE_LIMITS.rows-result.length+1);result.push(...await exportCompositeRows(specs,spec,selected,context.serializationHashContext));if(result.length>BUNDLE_LIMITS.rows)throw new Error('Composite row limit exceeded.');}return result.sort((a,b)=>(a as Wrapper).id.localeCompare((b as Wrapper).id));},
 parseAndMigrate(input){if(input.schemaVersion!==1)throw new Error('Unknown evidence module version.');const parsed=input.records.map(raw=>parsedComposite(specs,raw));validateChain(parsed);return parsed;},
 referenceValidationScope:'bundle' as const,validateReferences:validateEvidenceModuleReferences,
 async prepareReplace(_context,raws){const result:PhysicalImportRows[]=specs.map(spec=>({table:spec.table,records:[]}));const parsed=raws.map(raw=>parsedComposite(specs,raw));validateChain(parsed);for(const row of parsed){await exactIdentity(specs,row);const spec=specFor(specs,row.value);result.find(item=>item.table===spec.table)!.records.push({id:row.value.physicalId,value:row.value.record as JsonValue});}for(const item of result)if(new Set(item.records.map(row=>row.id)).size!==item.records.length)throw new Error('Duplicate physical record identity.');return result;},
};}
function validateChain(rows:Array<Wrapper&{value:Envelope}>):void{
 const heads=rows.filter(row=>row.value.kind==='head').map(row=>evidenceHeadSchema.parse(row.value.record));const versions=rows.filter(row=>row.value.kind==='version').map(row=>row.value.record as {id:string;version:number;recordedAt:string});
 if(new Set(heads.map(row=>row.id)).size!==heads.length)throw new Error('Duplicate logical head.');
 for(const head of heads){const chain=versions.filter(row=>row.id===head.id).sort((a,b)=>a.version-b.version);if(chain.length!==head.currentVersion||chain.some((row,index)=>row.version!==index+1||index>0&&Date.parse(row.recordedAt)<Date.parse(chain[index-1].recordedAt)))throw new Error('Incomplete version chain.');}
 if(versions.some(row=>!heads.some(head=>head.id===row.id)))throw new Error('Version has no head.');
}
export const attachmentUsageSchema=z.object({bytes:z.number().int().nonnegative().max(200*1024*1024),files:z.number().int().nonnegative().max(500)}).strict();
const singleSpecs:Spec[]=[{table:'evidence_links',kind:'mapping',parse:v=>evidenceLinkSchema.parse(v),legacy:true,marker:'evidenceId'},{table:'evidence_requirements',kind:'mapping',parse:v=>evidenceRequirementSchema.parse(v)},{table:'acceptance_records',kind:'mapping',parse:v=>acceptanceRecordSchema.parse(v)},{table:'attachments',kind:'head',parse:v=>attachmentRecordSchema.parse(v),legacy:true,marker:'status'},{table:'attachment_usage',kind:'mapping',parse:v=>attachmentUsageSchema.parse(v)}];
function singleValue(spec:Spec,row:Wrapper):{record:unknown;legacy:boolean}{
 if(spec.table==='attachment_usage'&&row.id!=='quota')throw new Error('Attachment usage must use the singleton quota identity.');
 if(object(row.value)&&row.value.kind==='legacy'){const value=envelopeSchema.parse(row.value);if(!spec.legacy||value.kind!=='legacy'||value.physicalId!==row.id)throw new Error('Invalid single legacy wrapper.');assertPortable(value.record);if(parseOrLegacy(spec,value.record).kind!=='legacy')throw new Error('Typed record cannot be downgraded to legacy.');return {record:value.record,legacy:true};}
 const record=spec.parse(row.value);if(object(record)&&typeof record.id==='string'&&record.id!==row.id)throw new Error('Module physical identity differs.');return {record,legacy:false};
}
function single(spec:Spec):ExportModule{return {key:spec.table,tables:[spec.table],schemaVersion:1,policy:'replace',legacyOptional:true,
 async exportRows(context){const rows=await boundedPages(after=>context.query.list(spec.table,{after,limit:BUNDLE_LIMITS.pageSize}));const serializationHashContext=context.serializationHashContext;return Promise.all(rows.map(async raw=>{const parsed=parseOrLegacy(spec,JSON.parse(raw.payload_json)),value=parsed.kind==='legacy'?{kind:'legacy',physicalId:raw.id,record:parsed.record}:parsed.record;const row={id:raw.id,rowRevision:raw.row_revision,contentHash:await serializationHash(canonical(value),serializationHashContext),value};singleValue(spec,wrapperSchema.parse(row));return row;}));},
 parseAndMigrate(input){if(input.schemaVersion!==1)throw new Error('Unknown evidence module version.');return input.records.map(raw=>{const row=wrapperSchema.parse(raw);assertPortable(row.value);singleValue(spec,row);return row;});},referenceValidationScope:'bundle' as const,validateReferences:validateEvidenceModuleReferences,
 prepareReplace(_context,raws){return [{table:spec.table,records:raws.map(raw=>{const row=wrapperSchema.parse(raw);return {id:row.id,value:singleValue(spec,row).record as JsonValue};})}];},
};}
export const evidenceExportAdapters:ExportModule[]=[composite('evidence',evidenceSpecs),composite('decisions',decisionSpecs),...singleSpecs.map(single)];
const refs=(kind:TypedReference['kind'],ids:string[],path:string,field?:string):TypedReference[]=>ids.map((id,index)=>({kind,id,path:[path,index,...(field?[field]:[])]}));
function subjectRef(value:{type:TypedReference['kind'];id:string},path:(string|number)[]):TypedReference{return {kind:value.type,id:value.id,path:[...path,'id']};}
function physicalRefs(table:RegisteredOwnerTable,value:unknown):TypedReference[]{
 if(table==='evidence_records'||table==='decision_records')return [];
 if(table==='evidence_versions'){const row=evidenceVersionSchema.parse(value);return [{kind:'evidence',id:row.id,path:['id']},...refs('attachment',row.attachmentIds,'attachmentIds'),...(row.sourceObservationRef?[{kind:'source-observation' as const,id:row.sourceObservationRef.id,path:['sourceObservationRef','id']}]:[])];}
 if(table==='evidence_mappings'){const row=legacyEvidenceMappingSchema.parse(value);return [subjectRef(row.subject,['subject']),{kind:'evidence',id:row.evidenceId,path:['evidenceId']}];}
 if(table==='evidence_links'){const row=evidenceLinkSchema.parse(value);return [subjectRef(row.subject,['subject']),{kind:'evidence',id:row.evidenceId,path:['evidenceId']}];}
 if(table==='evidence_requirements')return [subjectRef(evidenceRequirementSchema.parse(value).subject,['subject'])];
 if(table==='acceptance_records'){const row=acceptanceRecordSchema.parse(value);return [subjectRef(row.subject,['subject']),...refs('evidence',row.evidenceRefs.map(ref=>ref.id),'evidenceRefs','id'),...refs('decision',row.exceptions.map(item=>item.decisionId),'exceptions','decisionId')];}
 if(table==='decision_versions'){const row=decisionVersionSchema.parse(value);return [{kind:'decision',id:row.id,path:['id']},...row.subjects.map((subject,index)=>subjectRef(subject,['subjects',index])),...refs('evidence',row.evidenceRefs.map(ref=>ref.id),'evidenceRefs','id'),...(row.sourceCaptureId?[{kind:'capture' as const,id:row.sourceCaptureId,path:['sourceCaptureId']}]:[]),...(row.supersedesDecisionId?[{kind:'decision' as const,id:row.supersedesDecisionId,path:['supersedesDecisionId']}]:[])];}
 return [];
}
export const evidenceReferenceDescriptors:ReferenceDescriptor[]=[...evidenceSpecs,...decisionSpecs,...singleSpecs].map(spec=>({key:spec.table,schemaVersion:1,...(spec.table==='evidence_records'?{entityKind:'evidence' as const}:spec.table==='decision_records'?{entityKind:'decision' as const}:spec.table==='attachments'?{entityKind:'attachment' as const}:{}),parse(value){if(spec.kind==='legacy')throw new Error('Legacy records need explicit reference review.');return spec.parse(value);},references(value){return physicalRefs(spec.table,value);}}));
function compositeRows(context:ImportContext,key:string,specs:Spec[]){return (context.modules[key]?.records??[]).map(raw=>parsedComposite(specs,raw));}
/** Validate portable metadata references only; no attachment bytes or acceptance authority are inferred. */
export function validateEvidenceModuleReferences(context:ImportContext):void{
 const evidence=compositeRows(context,'evidence',evidenceSpecs),decisions=compositeRows(context,'decisions',decisionSpecs);validateChain(evidence);validateChain(decisions);
 const eVersions=evidence.filter(row=>row.value.kind==='version').map(row=>evidenceVersionSchema.parse(row.value.record)),dVersions=decisions.filter(row=>row.value.kind==='version').map(row=>decisionVersionSchema.parse(row.value.record));
 const typed=(table:RegisteredOwnerTable)=>{const spec=singleSpecs.find(item=>item.table===table)!;return (context.modules[table]?.records??[]).map(raw=>singleValue(spec,wrapperSchema.parse(raw))).filter(row=>!row.legacy).map(row=>row.record);};
 const attachments=typed('attachments').map(value=>attachmentRecordSchema.parse(value)),requirements=typed('evidence_requirements').map(value=>evidenceRequirementSchema.parse(value)),acceptances=typed('acceptance_records').map(value=>acceptanceRecordSchema.parse(value));
 const usage=typed('attachment_usage').map(value=>attachmentUsageSchema.parse(value));
 const attachmentRows=(context.modules.attachments?.records??[]).map(raw=>singleValue(singleSpecs.find(item=>item.table==='attachments')!,wrapperSchema.parse(raw)));
 if(usage.length>1)throw new Error('Duplicate attachment quota ledger.');
 if(usage.length){if(attachmentRows.some(row=>row.legacy))throw new Error('Legacy attachment quota requires explicit review.');const charged=attachments.filter(row=>row.status!=='deleted');if(usage[0].files!==charged.length||usage[0].bytes!==charged.reduce((total,row)=>total+row.expectedBytes,0))throw new Error('Attachment quota differs from charged metadata.');}
 else if(attachments.length)throw new Error('Typed attachments require a complete quota ledger.');
 const subject=(ref:{type:string;id:string})=>{const collection={project:'projects',milestone:'milestones',task:'tasks',capture:'captures'}[ref.type] as 'projects'|'milestones'|'tasks'|'captures'|undefined;if(!collection||!context.planning[collection].some(row=>row.id===ref.id))throw new Error('Evidence subject is missing.');};
 const evidenceRef=(ref:{id:string;version:number})=>{if(!eVersions.some(row=>row.id===ref.id&&row.version===ref.version))throw new Error('Exact evidence version is missing.');};
 for(const version of eVersions)if(version.sourceObservationRef){const ref=version.sourceObservationRef;const raw=context.modules.source_observations?.records.find(row=>(row as {id:string}).id===ref.id) as {value:unknown}|undefined;if(!raw)throw new Error('Source observation citation is missing.');const observation=sourceObservationSchema.parse(raw.value);if(observation.id!==ref.id||observation.contentDigest!==ref.contentDigest)throw new Error('Source observation citation digest differs.');}
 for(const version of eVersions)for(const id of version.attachmentIds)if(!attachments.some(row=>row.id===id))throw new Error('Evidence attachment is missing.');
 for(const row of evidence.filter(row=>row.value.kind==='mapping')){const mapping=legacyEvidenceMappingSchema.parse(row.value.record);subject(mapping.subject);evidenceRef({id:mapping.evidenceId,version:mapping.evidenceVersion});}
 for(const value of typed('evidence_links')){const link=evidenceLinkSchema.parse(value);subject(link.subject);evidenceRef({id:link.evidenceId,version:link.evidenceVersion});if(link.requirementId&&!requirements.some(row=>row.id===link.requirementId&&row.subject.id===link.subject.id&&row.subject.type===link.subject.type))throw new Error('Evidence requirement is missing.');}
 for(const row of requirements)subject(row.subject);
 for(const row of dVersions){for(const ref of row.subjects)subject(ref);for(const ref of row.evidenceRefs)evidenceRef(ref);if(row.sourceCaptureId)subject({type:'capture',id:row.sourceCaptureId});if(row.supersedesDecisionId&&!dVersions.some(previous=>previous.id===row.supersedesDecisionId))throw new Error('Superseded decision is missing.');}
 for(const row of acceptances){subject(row.subject);for(const ref of row.evidenceRefs){evidenceRef(ref);if(!requirements.some(requirement=>requirement.id===ref.requirementId&&requirement.subject.type===row.subject.type&&requirement.subject.id===row.subject.id))throw new Error('Acceptance requirement is missing.');}for(const exception of row.exceptions)if(!dVersions.some(version=>version.id===exception.decisionId&&version.version===exception.decisionVersion))throw new Error('Exact exception decision version is missing.');if(row.supersedesId&&!acceptances.some(prior=>prior.id===row.supersedesId))throw new Error('Prior acceptance is missing.');}
}
