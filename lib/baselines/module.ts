import {z} from 'zod';
import type {ExportContext,ExportModule,ImportContext} from '../workspace-export.ts';
import {assertPortable,boundedPages,BUNDLE_LIMITS} from '../workspace-export-core.ts';
import type {ReferenceDescriptor,TypedReference} from '../workspace-references.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {PROJECT_BASELINES} from '../project-baselines.ts';
import {reviewSourceWatermark} from '../reviews/freshness.ts';
import {reviewSnapshotSchema} from '../reviews/validation.ts';
import {sourceObservationSchema} from '../sources/validation.ts';
import {evidenceVersionSchema} from '../evidence-validation.ts';
import {decisionVersionSchema} from '../decisions.ts';
import {BASELINE_REVISION_LIMITS} from './contracts.ts';
import {baselineRevisionSchema} from './validation.ts';
const table='project_baseline_revisions' as const;
const wrapper=z.object({id:z.string().min(1).max(128).refine(value=>value.trim()===value),rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
function parse(raw:unknown){const row=wrapper.parse(raw);assertPortable(row.value);const value=baselineRevisionSchema.parse(row.value);if(row.id!==value.id||canonical(row.value)!==canonical(value))throw new Error('Baseline identity or canonical shape differs.');return {...row,value};}
function rows(input:unknown[]){if(input.length>BASELINE_REVISION_LIMITS.ownerRows)throw new Error('Baseline owner row limit exceeded.');const parsed=input.map(parse);if(new Set(parsed.map(row=>row.id)).size!==parsed.length)throw new Error('Duplicate baseline revision identity.');return parsed;}
function chain(parsed:ReturnType<typeof rows>){
 const index=new Map(parsed.map(row=>[row.id,row]));
 for(const row of parsed){const visited=new Set([row.id]);let current=row;while(current.value.parent.kind==='revision'){
  const parent=current.value.parent,next=index.get(parent.id);if(!next||next.value.projectId!==current.value.projectId||next.contentHash!==parent.hash)throw new Error('Baseline parent project or immutable digest differs.');if(visited.has(next.id))throw new Error('Baseline parent cycle.');if(Date.parse(next.value.recordedAt)>Date.parse(current.value.recordedAt))throw new Error('Baseline parent follows its child.');visited.add(next.id);current=next;
 }}
}
async function verify(parsed:ReturnType<typeof rows>,context?:ImportContext){
 chain(parsed);
 for(const row of parsed){
  if(await contentHash(canonical(row.value))!==row.contentHash)throw new Error('Baseline revision digest differs.');
  const parent=row.value.parent;if(parent.kind==='bundled'){const bundled=PROJECT_BASELINES.find(item=>item.id===parent.baselineId&&item.key===parent.key);if(!bundled||await contentHash(canonical(bundled))!==parent.packageHash)throw new Error('Bundled baseline package digest differs.');}
  if(await reviewSourceWatermark(row.value.observationRefs)!==row.value.sourceWatermark)throw new Error('Baseline selected source watermark differs.');
  if(context){const raw=context.modules.review_snapshots?.records.find(item=>wrapper.parse(item).id===row.value.snapshotRef.id);if(!raw)throw new Error('Baseline review snapshot is missing.');const snapshot=wrapper.parse(raw);if(await contentHash(canonical(snapshot.value))!==row.value.snapshotRef.hash)throw new Error('Baseline review snapshot digest differs.');const frozen=reviewSnapshotSchema.parse(snapshot.value);if(await reviewSourceWatermark(frozen.sourceSet)!==frozen.sourceWatermark)throw new Error('Baseline frozen review source watermark differs.');for(const item of frozen.planningRecords)if(await contentHash(canonical(item.value))!==item.contentHash)throw new Error('Baseline frozen planning digest differs.');for(const item of frozen.auditRecords)if(await contentHash(canonical(item.value))!==item.ref.contentHash)throw new Error('Baseline frozen audit digest differs.');for(const ref of row.value.observationRefs){const observation=context.modules.source_observations?.records.map(item=>sourceObservationSchema.parse(wrapper.parse(item).value)).find(item=>item.id===ref.id);if(!observation||await contentHash(canonical(observation.payload))!==ref.contentDigest)throw new Error('Baseline source payload digest differs.');}}
 }
}
async function exported(context:ExportContext){const stored=await boundedPages(after=>context.query.list(table,{after,limit:BUNDLE_LIMITS.pageSize}));const parsed=rows(stored.map(row=>({id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,value:JSON.parse(row.payload_json)})));await verify(parsed);return parsed;}
/** Imported freshness is immutable historical provenance. No private head, source proof,
 * grant, execution intent or current owner authority is exported or recreated here. */
export const baselineExportAdapters:ExportModule[]=[{key:table,tables:[table],schemaVersion:1,policy:'replace',legacyOptional:true,exportRows:exported,parseAndMigrate(input){if(input.schemaVersion!==1)throw new Error('Unknown baseline module schema.');const parsed=rows(input.records);chain(parsed);return parsed;},validateReferences:validateBaselineModuleReferences,async prepareReplace(context,input){const parsed=rows(input),validated={...context,modules:{...context.modules,[table]:{schemaVersion:1,records:parsed}}};validateBaselineModuleReferences(validated);await verify(parsed,validated);return [{table,records:parsed.map(row=>({id:row.id,value:row.value as unknown as JsonValue}))}];}}];
const ref=(kind:TypedReference['kind'],id:string,path:(string|number)[]):TypedReference=>({kind,id,path});
export const baselineReferenceDescriptors:ReferenceDescriptor[]=[{key:table,schemaVersion:1,entityKind:'baseline-revision',parse(value){assertPortable(value);return baselineRevisionSchema.parse(value);},references(value){const row=baselineRevisionSchema.parse(value);return [ref('project',row.projectId,['projectId']),ref('review-snapshot',row.snapshotRef.id,['snapshotRef','id']),...(row.parent.kind==='revision'?[ref('baseline-revision',row.parent.id,['parent','id'])]:[]),...row.observationRefs.map((r,i)=>ref('source-observation',r.id,['observationRefs',i,'id'])),...row.evidenceRefs.map((r,i)=>ref('evidence',r.id,['evidenceRefs',i,'id'])),...row.decisionRefs.map((r,i)=>ref('decision',r.id,['decisionRefs',i,'id']))];}}];
export function validateBaselineModuleReferences(context:ImportContext):void{
 const parsed=rows(context.modules[table]?.records??[]);chain(parsed);
 const snapshots=(context.modules.review_snapshots?.records??[]).map(raw=>{const row=wrapper.parse(raw);return {...row,value:reviewSnapshotSchema.parse(row.value)};});
 const observations=(context.modules.source_observations?.records??[]).map(raw=>sourceObservationSchema.parse(wrapper.parse(raw).value));
 const versions=(key:string)=>(context.modules[key]?.records??[]).flatMap(raw=>{const value=wrapper.parse(raw).value as {kind?:unknown;record?:unknown};return value.kind==='version'?[value.record]:[];});
 const evidence=versions('evidence').map(raw=>evidenceVersionSchema.parse(raw)),decisions=versions('decisions').map(raw=>decisionVersionSchema.parse(raw));
 for(const {value:row}of parsed){
  if(!context.planning.projects.some(project=>project.id===row.projectId))throw new Error('Baseline project is missing.');
  const snapshot=snapshots.find(item=>item.id===row.snapshotRef.id&&item.contentHash===row.snapshotRef.hash)?.value;if(!snapshot||!snapshot.scope.projectIds.includes(row.projectId)||Date.parse(snapshot.generatedAt)>Date.parse(row.reviewedAsOf))throw new Error('Exact baseline review snapshot scope or date differs.');
  for(const r of row.observationRefs)if(!snapshot.facts.some(fact=>fact.projectId===row.projectId&&fact.observationRefs.some(item=>canonical(item)===canonical(r)))||!snapshot.sourceSet.some(item=>canonical(item)===canonical(r))||!observations.some(item=>item.id===r.id&&item.contentDigest===r.contentDigest))throw new Error('Exact selected baseline observation is missing.');
  for(const r of row.evidenceRefs)if(!snapshot.facts.some(fact=>fact.projectId===row.projectId&&fact.evidenceRefs.some(item=>canonical(item)===canonical(r)))||!evidence.some(item=>item.id===r.id&&item.version===r.version))throw new Error('Exact selected baseline evidence version is missing.');
  for(const r of row.decisionRefs){const frozen=snapshot.decisionVersions.find(item=>item.id===r.id&&item.version===r.version),actual=decisions.find(item=>item.id===r.id&&item.version===r.version);if(!snapshot.facts.some(fact=>fact.projectId===row.projectId&&fact.decisionRefs.some(item=>canonical(item)===canonical(r)))||!frozen||!actual||canonical(frozen)!==canonical(actual))throw new Error('Exact selected baseline decision version differs.');}
  // An initial project hash is an historical claim. Comparing it to the live
  // project would rewrite or invalidate legitimate older context after an edit.
 }
}
