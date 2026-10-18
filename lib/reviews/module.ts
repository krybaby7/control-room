import {z} from 'zod';
import type {ExportContext,ExportModule,ImportContext} from '../workspace-export.ts';
import {assertPortable,boundedPages,BUNDLE_LIMITS} from '../workspace-export-core.ts';
import type {ModuleRow} from '../workspace-modules.ts';
import type {ReferenceDescriptor,TypedReference} from '../workspace-references.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceVersionSchema} from '../evidence-validation.ts';
import {decisionVersionSchema} from '../decisions.ts';
import {sourceObservationSchema} from '../sources/validation.ts';
import {automationScheduleSchema,automationOccurrenceSchema} from '../automations/validation.ts';
import {reviewSnapshotSchema,reviewAcknowledgementSchema,notificationEventSchema,notificationPreferencesSchema,analysisPolicySchema,reviewAnalysisSchema} from './validation.ts';
const specs=[
 {key:'review_snapshots',schema:reviewSnapshotSchema,stream:'reviews',entityKind:'review-snapshot'},
 {key:'review_acknowledgements',schema:reviewAcknowledgementSchema},
 {key:'automation_schedules',schema:automationScheduleSchema,entityKind:'automation-schedule'},
 {key:'automation_occurrences',schema:automationOccurrenceSchema,stream:'automations'},
 {key:'notification_events',schema:notificationEventSchema,stream:'notifications'},
 {key:'review_settings',schema:z.union([notificationPreferencesSchema,analysisPolicySchema])},
 {key:'review_analysis_runs',schema:reviewAnalysisSchema,stream:'reviews'},
] as const;
type Spec=typeof specs[number];
const wrapper=z.object({id:z.string().min(1).max(128).refine(value=>value.trim()===value),rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
function parse(spec:Spec,raw:unknown){const row=wrapper.parse(raw);assertPortable(row.value);const value=spec.schema.parse(row.value);if(row.id!==value.id||canonical(value)!==canonical(row.value))throw new Error('Review payload identity or canonical shape differs.');return {...row,value};}
function rows(spec:Spec,input:unknown[]){if(input.length>BUNDLE_LIMITS.rows)throw new Error('Review module row limit exceeded.');const parsed=input.map(raw=>parse(spec,raw));if(new Set(parsed.map(row=>row.id)).size!==parsed.length)throw new Error('Duplicate review identity.');return parsed;}
async function verify(spec:Spec,raw:unknown){const row=parse(spec,raw);if(await contentHash(canonical(row.value))!==row.contentHash)throw new Error('Review payload digest differs.');if(spec.key==='review_snapshots'){const snapshot=reviewSnapshotSchema.parse(row.value);for(const frozen of snapshot.planningRecords)if(await contentHash(canonical(frozen.value))!==frozen.contentHash)throw new Error('Frozen planning digest differs.');for(const frozen of snapshot.auditRecords)if(await contentHash(canonical(frozen.value))!==frozen.ref.contentHash)throw new Error('Frozen audit digest differs.');}return row;}
async function exported(spec:Spec,context:ExportContext){
 const watermark='stream' in spec?context.operationalWatermarks?.[spec.stream]:undefined;
 if(watermark!==undefined&&(!Number.isSafeInteger(watermark)||watermark<0))throw new Error('Invalid review operational watermark.');
 const stored=await boundedPages(async after=>{
  if(!('stream' in spec)||watermark===undefined)return context.query.list(spec.key,{after,limit:BUNDLE_LIMITS.pageSize});
  return (await context.db.prepare(`SELECT id,row_revision,payload_json,content_hash FROM ${spec.key} WHERE user_id=? AND id>? AND stream_sequence>=0 AND stream_sequence<=? ORDER BY id LIMIT ?`).bind(context.userId,after,watermark,BUNDLE_LIMITS.pageSize).all<ModuleRow>()).results;
 });
 const result=[];for(const raw of stored)result.push(await verify(spec,{id:raw.id,rowRevision:raw.row_revision,contentHash:raw.content_hash,value:JSON.parse(raw.payload_json)}));return result;
}
/** Portable records contain historical claims/configuration, never private consent, delivery grants or runnable work. */
export const reviewExportAdapters:ExportModule[]=specs.map(spec=>({key:spec.key,tables:[spec.key],schemaVersion:1,policy:'replace',legacyOptional:true,exportRows:context=>exported(spec,context),parseAndMigrate(input){if(input.schemaVersion!==1)throw new Error('Unknown review module version.');return rows(spec,input.records);},validateReferences:validateReviewModuleReferences,async prepareReplace(_context,input){return [{table:spec.key,records:await Promise.all(rows(spec,input).map(async raw=>{const row=await verify(spec,raw);return {id:row.id,value:row.value as unknown as JsonValue};}))}];}}));
const ref=(kind:TypedReference['kind'],id:string,path:(string|number)[]):TypedReference=>({kind,id,path});
function references(spec:Spec,value:unknown):TypedReference[]{
 if(spec.key==='review_snapshots'){
  const row=reviewSnapshotSchema.parse(value),result:TypedReference[]=[];
  for(const [i,fact] of row.facts.entries()){
   for(const [j,item] of fact.evidenceRefs.entries())result.push(ref('evidence',item.id,['facts',i,'evidenceRefs',j,'id']));
   for(const [j,item] of fact.decisionRefs.entries())result.push(ref('decision',item.id,['facts',i,'decisionRefs',j,'id']));
  }
  for(const [i,item] of row.sourceSet.entries())result.push(ref('source-observation',item.id,['sourceSet',i,'id']));
  for(const [i,decision] of row.decisionVersions.entries()){
   result.push(ref('decision',decision.id,['decisionVersions',i,'id']));
   for(const [j,item] of decision.evidenceRefs.entries())result.push(ref('evidence',item.id,['decisionVersions',i,'evidenceRefs',j,'id']));
  }
  return result; // Frozen planning/audit bodies never become live entity dependencies.
 }
 if(spec.key==='review_acknowledgements'){const row=reviewAcknowledgementSchema.parse(value);return [ref('review-snapshot',row.snapshotId,['snapshotId'])];}
 if(spec.key==='automation_schedules'){const row=automationScheduleSchema.parse(value);return [...row.projectIds.map((id,i)=>ref('project',id,['projectIds',i])),...(row.sourceId?[ref('source',row.sourceId,['sourceId'])]:[])];}
 if(spec.key==='automation_occurrences'){const row=automationOccurrenceSchema.parse(value);return [ref('automation-schedule',row.scheduleId,['scheduleId']),...(row.resultRef?.kind==='review'?[ref('review-snapshot',row.resultRef.id,['resultRef','id'])]:[])];}
 if(spec.key==='review_analysis_runs'){const row=reviewAnalysisSchema.parse(value);return [ref('review-snapshot',row.snapshotId,['snapshotId']),...row.suggestions.flatMap((item,i)=>[...item.evidenceRefs.map((r,j)=>ref('evidence',r.id,['suggestions',i,'evidenceRefs',j,'id'])),...item.observationRefs.map((r,j)=>ref('source-observation',r.id,['suggestions',i,'observationRefs',j,'id']))])];}
 if(spec.key==='notification_events'){const row=notificationEventSchema.parse(value);return [...(row.projectId?[ref('project',row.projectId,['projectId'])]:[]),...(row.sourceId?[ref('source',row.sourceId,['sourceId'])]:[]),...(row.snapshotRef?[ref('review-snapshot',row.snapshotRef.id,['snapshotRef','id'])]:[]),...row.observationRefs.map((r,i)=>ref('source-observation',r.id,['observationRefs',i,'id'])),...row.evidenceRefs.map((r,i)=>ref('evidence',r.id,['evidenceRefs',i,'id']))];}
 const row=z.union([notificationPreferencesSchema,analysisPolicySchema]).parse(value);return row.id==='notifications'?row.mutedSourceIds.map((id,i)=>ref('source',id,['mutedSourceIds',i])):[];
}
export const reviewReferenceDescriptors:ReferenceDescriptor[]=specs.map(spec=>({key:spec.key,schemaVersion:1,...('entityKind' in spec?{entityKind:spec.entityKind}:{}),parse(value){assertPortable(value);return spec.schema.parse(value);},references:value=>references(spec,value)}));
export function validateReviewModuleReferences(context:ImportContext):void{
 const values=(key:Spec['key'])=>rows(specs.find(spec=>spec.key===key)!,context.modules[key]?.records??[]);
 const snapshots=values('review_snapshots').map(row=>({...row,snapshot:reviewSnapshotSchema.parse(row.value)}));
 const observations=(context.modules.source_observations?.records??[]).map(raw=>sourceObservationSchema.parse(wrapper.parse(raw).value));
 const versions=(key:string)=>(context.modules[key]?.records??[]).flatMap(raw=>{const value=wrapper.parse(raw).value as {kind?:unknown;record?:unknown};return value.kind==='version'?[value.record]:[];});
 const evidence=versions('evidence').map(value=>evidenceVersionSchema.parse(value)),decisions=versions('decisions').map(value=>decisionVersionSchema.parse(value));
 const sourceIds=new Set((context.modules.source_targets?.records??[]).map(raw=>wrapper.parse(raw).id));
 const requireEvidence=(r:{id:string;version:number})=>{if(!evidence.some(e=>e.id===r.id&&e.version===r.version))throw new Error('Exact review evidence version is missing.');};
 const requireObservation=(r:{id:string;contentDigest:string})=>{if(!observations.some(o=>o.id===r.id&&o.contentDigest===r.contentDigest))throw new Error('Exact review observation digest is missing.');};
 const snapshotFor=(id:string,hash?:string)=>{const row=snapshots.find(item=>item.id===id);if(!row||hash!==undefined&&row.contentHash!==hash)throw new Error('Exact review snapshot is missing.');return row.snapshot;};
 for(const {snapshot} of snapshots){
  for(const r of snapshot.sourceSet)requireObservation(r);
  for(const fact of snapshot.facts)for(const r of fact.evidenceRefs)requireEvidence(r);
  for(const frozen of snapshot.decisionVersions){const current=decisions.find(d=>d.id===frozen.id&&d.version===frozen.version);if(!current||canonical(current)!==canonical(frozen))throw new Error('Exact frozen decision version differs.');for(const r of frozen.evidenceRefs)requireEvidence(r);}
 }
 for(const row of values('review_acknowledgements')){const ack=reviewAcknowledgementSchema.parse(row.value),snapshot=snapshotFor(ack.snapshotId,ack.snapshotHash);if(canonical(ack.scope)!==canonical(snapshot.scope)||ack.coveredFactIds.some(id=>!snapshot.coverage.includedFactIds.includes(id))||ack.coveredEventIds.some(id=>!snapshot.coverage.includedEventIds.includes(id)))throw new Error('Acknowledgement coverage differs from its frozen snapshot.');}
 const schedules=values('automation_schedules').map(row=>automationScheduleSchema.parse(row.value));
 for(const schedule of schedules)if(schedule.projectIds.some(id=>!context.planning.projects.some(p=>p.id===id))||schedule.sourceId&&!sourceIds.has(schedule.sourceId))throw new Error('Schedule current project or source is missing.');
 for(const row of values('automation_occurrences')){const occurrence=automationOccurrenceSchema.parse(row.value),schedule=schedules.find(s=>s.id===occurrence.scheduleId);if(!schedule||schedule.kind!==occurrence.kind||Date.parse(occurrence.finishedAt)<Date.parse(occurrence.startedAt)||occurrence.outcome==='success'&&occurrence.failure!==null)throw new Error('Occurrence terminal history differs.');if(occurrence.resultRef?.kind==='review')snapshotFor(occurrence.resultRef.id,occurrence.resultRef.hash??undefined);}
 const analyses=values('review_analysis_runs').map(row=>reviewAnalysisSchema.parse(row.value));
 for(const analysis of analyses){const snapshot=snapshotFor(analysis.snapshotId,analysis.snapshotHash);if(analysis.status!=='completed'&&analysis.suggestions.length)throw new Error('Uncompleted analysis contains suggestions.');if(new Set(analysis.suggestions.map(s=>s.id)).size!==analysis.suggestions.length)throw new Error('Duplicate analysis suggestion.');for(const suggestion of analysis.suggestions){const facts=suggestion.factIds.map(id=>snapshot.facts.find(f=>f.id===id));if(!facts.length||facts.some(f=>!f))throw new Error('Analysis fact is missing.');for(const r of suggestion.evidenceRefs){requireEvidence(r);if(!facts.some(f=>f!.evidenceRefs.some(e=>canonical(e)===canonical(r))))throw new Error('Analysis evidence differs from its selected facts.');}for(const r of suggestion.observationRefs){requireObservation(r);if(!facts.some(f=>f!.observationRefs.some(o=>canonical(o)===canonical(r))))throw new Error('Analysis observation differs from its selected facts.');}}}
 for(const {snapshot} of snapshots)if(snapshot.modelRunId&&!analyses.some(a=>a.id===snapshot.modelRunId&&a.snapshotId===snapshot.id))throw new Error('Frozen model run is missing.');
 for(const row of values('notification_events')){const notification=notificationEventSchema.parse(row.value);if(notification.projectId&&!context.planning.projects.some(p=>p.id===notification.projectId)||notification.sourceId&&!sourceIds.has(notification.sourceId))throw new Error('Notification current project or source is missing.');if(notification.snapshotRef){const snapshot=snapshotFor(notification.snapshotRef.id,notification.snapshotRef.hash);if(notification.factIds.some(id=>!snapshot.facts.some(f=>f.id===id)))throw new Error('Notification frozen fact is missing.');}else if(notification.factIds.length)throw new Error('Notification facts require a frozen snapshot.');notification.evidenceRefs.forEach(requireEvidence);notification.observationRefs.forEach(requireObservation);}
 for(const row of values('review_settings')){const setting=z.union([notificationPreferencesSchema,analysisPolicySchema]).parse(row.value);if(setting.id==='notifications'&&setting.mutedSourceIds.some(id=>!sourceIds.has(id)))throw new Error('Muted notification source is missing.');}
}
