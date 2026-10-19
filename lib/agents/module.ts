import {z} from 'zod';
import type {ExportContext,ExportModule,ImportContext} from '../workspace-export.ts';
import {assertPortable,boundedPages,BUNDLE_LIMITS} from '../workspace-export-core.ts';
import type {ReferenceDescriptor,TypedReference} from '../workspace-references.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {agentIdSchema,agentJobRecordSchema,agentResultRecordSchema} from './contracts.ts';
import {validateAgentJobRecord} from './policy.ts';
import {evaluationRunObservationSchema,validateEvaluationObservation} from './evaluation-import.ts';
const specs=[
 {key:'agent_jobs',schema:agentJobRecordSchema,limit:500,entityKind:'agent-job'},
 {key:'agent_results',schema:agentResultRecordSchema,limit:500,entityKind:'agent-result'},
 {key:'evaluation_runs',schema:evaluationRunObservationSchema,limit:1000,entityKind:'evaluation-run'},
] as const;
type Spec=typeof specs[number];
const wrapper=z.object({id:agentIdSchema,rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/u),value:z.unknown()}).strict();
function parse(spec:Spec,raw:unknown){assertPortable(raw);const row=wrapper.parse(raw),value=spec.schema.parse(row.value);if(row.id!==value.id||canonical(value)!==canonical(row.value))throw new Error('Agent portable identity or shape differs.');return {...row,value};}
function rows(spec:Spec,raw:unknown[]){if(raw.length>spec.limit)throw new Error('Agent portable owner limit exceeded.');const parsed=raw.map(value=>parse(spec,value));if(new Set(parsed.map(row=>row.id)).size!==parsed.length)throw new Error('Duplicate agent portable identity.');return parsed;}
async function verify(spec:Spec,raw:unknown){const row=parse(spec,raw);if(await contentHash(canonical(row.value))!==row.contentHash)throw new Error('Agent portable body digest differs.');if(spec.key==='agent_jobs')await validateAgentJobRecord(row.value);if(spec.key==='evaluation_runs')await validateEvaluationObservation(row.value);if(spec.key==='agent_results'){const value=agentResultRecordSchema.parse(row.value);await validateAgentJobRecord(value.frozenJob);if(value.jobId!==value.frozenJob.id||value.attemptId!==value.result.attemptId||await contentHash(canonical(value.result))!==value.resultSha256)throw new Error('Agent result proof digest differs.');}return row;}
async function exported(spec:Spec,context:ExportContext){const stored=await boundedPages(after=>spec.key!=='agent_jobs'&&context.operationalWatermarks?context.db.prepare('SELECT id,row_revision,payload_json,content_hash FROM '+spec.key+' WHERE user_id=? AND id>? AND stream_sequence<=? ORDER BY id LIMIT ?').bind(context.userId,after,context.operationalWatermarks.agents??0,BUNDLE_LIMITS.pageSize).all<import('../workspace-modules.ts').ModuleRow>().then(result=>result.results):context.query.list(spec.key,{after,limit:BUNDLE_LIMITS.pageSize}));const parsed=rows(spec,stored.map(row=>({id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,value:JSON.parse(row.payload_json)})));for(const row of parsed)await verify(spec,row);return parsed;}
/** Historical proposals/results and sanitized evaluation claims only. Approvals,
 * capabilities, tokens, attempts, process identities, slots and budget grants are excluded. */
export const agentExportAdapters:ExportModule[]=specs.map(spec=>({key:spec.key,tables:[spec.key],schemaVersion:1,policy:'replace',legacyOptional:true,exportRows:context=>exported(spec,context),parseAndMigrate(input){if(input.schemaVersion!==1)throw new Error('Unknown agent portable version.');return rows(spec,input.records);},referenceValidationScope:'bundle' as const,validateReferences:validateAgentModuleReferences,async prepareReplace(context,input){const parsed=rows(spec,input);validateAgentModuleReferences({...context,modules:{...context.modules,[spec.key]:{schemaVersion:1,records:parsed}}});const records=[];for(const raw of parsed){const row=await verify(spec,raw);records.push({id:row.id,value:{...row.value,historical:true,...(spec.key==='agent_results'?{frozenJob:{...agentResultRecordSchema.parse(row.value).frozenJob,historical:true}}:{})} as unknown as JsonValue});}return [{table:spec.key,records}];}}));
const ref=(kind:TypedReference['kind'],id:string,path:(string|number)[]):TypedReference=>({kind,id,path});
export const agentReferenceDescriptors:ReferenceDescriptor[]=specs.map(spec=>({key:spec.key,schemaVersion:1,entityKind:spec.entityKind,parse(value){assertPortable(value);return spec.schema.parse(value);},references(value){
 if(spec.key==='agent_jobs'){const v=agentJobRecordSchema.parse(value);return [ref('project',v.spec.projectId,['spec','projectId']),ref('task',v.spec.taskId,['spec','taskId']),...v.spec.inputArtifactIds.map((id,index)=>ref('attachment',id,['spec','inputArtifactIds',index])),...v.spec.dependsOnJobIds.map((id,index)=>ref('agent-job',id,['spec','dependsOnJobIds',index])),...(v.retryOfJobId?[ref('agent-job',v.retryOfJobId,['retryOfJobId'])]:[])];}
 if(spec.key==='agent_results'){const v=agentResultRecordSchema.parse(value);if(v.historical)return [];return [ref('agent-job',v.jobId,['jobId']),...v.result.artifactIds.map((id,index)=>ref('attachment',id,['result','artifactIds',index]))];}
 const v=evaluationRunObservationSchema.parse(value);return [ref('device',v.deviceId,['deviceId'])];
}}));
export function validateAgentModuleReferences(context:ImportContext):void{
 const get=(key:Spec['key'])=>{const spec=specs.find(value=>value.key===key)!;return rows(spec,context.modules[key]?.records??[]).map(row=>row.value);};
 const jobs=get('agent_jobs').map(v=>agentJobRecordSchema.parse(v)),results=get('agent_results').map(v=>agentResultRecordSchema.parse(v)),evaluations=get('evaluation_runs').map(v=>evaluationRunObservationSchema.parse(v));
 const ids=new Set(jobs.map(v=>v.id)),attachmentIds=new Set((context.modules.attachments?.records??[]).map(row=>z.object({id:z.string()}).passthrough().parse(row).id)),deviceIds=new Set((context.modules.devices?.records??[]).map(row=>z.object({id:z.string()}).passthrough().parse(row).id));
 for(const value of jobs){if(!context.planning.projects.some(p=>p.id===value.spec.projectId)||!context.planning.tasks.some(t=>t.id===value.spec.taskId&&t.projectId===value.spec.projectId)||value.spec.inputArtifactIds.some(id=>!attachmentIds.has(id))||value.spec.dependsOnJobIds.some(id=>!ids.has(id))||value.retryOfJobId&&!ids.has(value.retryOfJobId))throw new Error('Agent proposal reference is missing.');}
 for(const value of results)if(!value.historical&&(!ids.has(value.jobId)||value.result.artifactIds.some(id=>!attachmentIds.has(id))||canonical({...indexJob(jobs,value.jobId),historical:true})!==canonical({...value.frozenJob,historical:true})))throw new Error('Historical result reference is missing.');
 for(const value of evaluations)if(!deviceIds.has(value.deviceId))throw new Error('Evaluation device context is missing.');
 const colors=new Map<string,number>(),index=new Map(jobs.map(v=>[v.id,v]));const visit=(id:string)=>{if(colors.get(id)===1)throw new Error('Historical agent dependency cycle.');if(colors.get(id)===2)return;colors.set(id,1);for(const next of index.get(id)!.spec.dependsOnJobIds)visit(next);colors.set(id,2);};for(const value of jobs)visit(value.id);
}

function indexJob(jobs:ReturnType<typeof agentJobRecordSchema.parse>[],id:string){const row=jobs.find(value=>value.id===id);if(!row)throw new Error('Native result proposal context is missing.');return row;}
