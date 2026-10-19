import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewExportAdapters,reviewReferenceDescriptors,validateReviewModuleReferences} from '../lib/reviews/module.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {database} from './helpers/sqlite.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import type {ImportContext,ExportContext} from '../lib/workspace-export.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
import type {ReviewSnapshot} from '../lib/reviews/contracts.ts';
const now='2026-10-18T12:00:00.000Z',hash='a'.repeat(64),planning=workspaceFixture(),projectId=planning.projects[0].id;
const oldProject={id:projectId,name:'Historical title differs from the present'},projectHash=await contentHash(canonical(oldProject));
const frozen={kind:'project' as const,id:projectId,workspaceRevision:1,contentHash:projectHash};
const snapshot:ReviewSnapshot={id:'snapshot',scope:{projectIds:[projectId],filterDigest:hash},workspaceRevision:1,operationalWatermarks:{sources:5},sourceWatermark:hash,sourceSet:[],generatedAt:now,facts:[{id:'fact',projectId,kind:'progress',text:'Historical observation, not current authority.',evidenceRefs:[],decisionRefs:[],observationRefs:[],planningRefs:[frozen],auditRefs:[],observedAt:null,sourceUpdatedAt:null,basis:'documented',href:'/?view=review'}],unknowns:[],decisionVersions:[],planningRecords:[{...frozen,value:oldProject}],auditRecords:[],coverage:{complete:true,remainingFacts:0,includedFactIds:['fact'],includedEventIds:[]},modelRunId:null};
const snapshotHash=await contentHash(canonical(snapshot));
const ack={id:'ack',snapshotId:'snapshot',snapshotHash,scope:snapshot.scope,acknowledgedAt:now,coveredFactIds:['fact'],coveredEventIds:[]};
const schedule={id:'schedule',kind:'daily_review',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'03:00'},sourceId:null,projectIds:[projectId],catchUp:'latest_only',createdAt:now,updatedAt:now,archivedAt:null};
const occurrence={id:'occurrence',scheduleId:'schedule',dueAt:now,kind:'daily_review',configurationHash:hash,startedAt:now,finishedAt:now,outcome:'success',failure:null,missedPeriods:0,resultRef:{kind:'review',id:'snapshot',hash:snapshotHash}};
const notification={id:'notification',dedupKey:hash,kind:'blocker',severity:'warning',projectId:null,sourceId:null,title:'Historical review',body:'Untrusted plain text',href:'/?view=review',createdAt:now,factIds:['fact'],snapshotRef:{id:'snapshot',hash:snapshotHash},observationRefs:[],evidenceRefs:[]};
const settings={id:'analysis',enabled:true,provider:'fixture',model:'exact',maxCostDollars:1,maxInputBytes:1000,maxOutputTokens:100,timeoutMs:1000};
const analysis={id:'analysis-result',snapshotId:'snapshot',snapshotHash,provider:'fixture',model:'exact',inputDigest:hash,status:'completed',startedAt:now,finishedAt:now,usage:{inputTokens:null,outputTokens:null,costDollars:null},suggestions:[{id:'suggestion',text:'Inferred: inspect the observation.',factIds:['fact'],evidenceRefs:[],observationRefs:[]}],diagnostic:null};
const records=[snapshot,ack,schedule,occurrence,notification,settings,analysis];
async function wrapper<T extends {id:string}>(value:T){return {id:value.id,rowRevision:2,contentHash:await contentHash(canonical(value)),value};}
async function fixture():Promise<ImportContext>{const modules:ImportContext['modules']={};for(const [i,adapter] of reviewExportAdapters.entries())modules[adapter.key]={schemaVersion:1,records:[await wrapper(records[i])]};return {planning:structuredClone(planning),modules};}
async function replace<T extends {id:string}>(context:ImportContext,key:string,value:T){context.modules[key].records=[await wrapper(value)];}
test('seven strict adapters roundtrip exact portable history without private grant material',async()=>{
 const ctx=await fixture();assert.equal(reviewExportAdapters.length,7);validateReviewModuleReferences(ctx);
 for(const adapter of reviewExportAdapters){assert.equal(adapter.legacyOptional,true);const parsed=adapter.parseAndMigrate(ctx.modules[adapter.key]);const split=await adapter.prepareReplace!(ctx,parsed);assert.deepEqual(split,[{table:adapter.key,records:[{id:(parsed[0] as {id:string}).id,value:(parsed[0] as {value:unknown}).value}]}]);assert.deepEqual(await adapter.prepareReplace!({planning,modules:{}},[]),[{table:adapter.key,records:[]}]);}
 validateReviewModuleReferences({planning,modules:{}});
 assert.equal(canonical(ctx.modules).includes('grant'),false);assert.equal((ctx.modules.review_settings.records[0] as {value:typeof settings}).value.enabled,true);
 assert.ok(reviewReferenceDescriptors.find(d=>d.key==='automation_schedules')!.references(schedule).some(r=>r.kind==='project'));
 assert.equal(reviewReferenceDescriptors.find(d=>d.key==='review_snapshots')!.references(snapshot).some(r=>r.kind==='project'),false);
});
test('unknown authority fields/wrappers/versions, duplicate IDs and changed payload digest fail closed',async()=>{
 const ctx=await fixture();for(const [i,adapter] of reviewExportAdapters.entries()){
  const raw=await wrapper(records[i]);
  for(const field of ['grant','principal','lease','credential','acknowledgedBy'])assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...raw,value:{...records[i],[field]:'private'}}]}));
  assert.throws(()=>adapter.parseAndMigrate({schemaVersion:2,records:[]}));assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[raw,raw]}));assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...raw,id:'wrong'}]}));assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...raw,secret:'private'}]}));
  await assert.rejects(async()=>adapter.prepareReplace!(ctx,[{...raw,contentHash:'0'.repeat(64)}]));
 }
});
test('frozen historical bodies survive current planning changes but tampered embedded hashes reject',async()=>{
 const ctx=await fixture();ctx.planning.projects[0].name='New current title';validateReviewModuleReferences(ctx);
 const adapter=reviewExportAdapters[0];await adapter.prepareReplace!(ctx,ctx.modules.review_snapshots.records);
 const altered={...snapshot,planningRecords:[{...snapshot.planningRecords[0],value:{...oldProject,name:'Tampered'}}]};
 await assert.rejects(async()=>adapter.prepareReplace!(ctx,[await wrapper(altered)]));
 const auditValue={id:'event',message:'historical'},auditHash=await contentHash(canonical(auditValue));
 const withAudit={...snapshot,auditRecords:[{ref:{eventId:'event',contentHash:auditHash,workspaceRevision:1,ordinal:0,streamId:null,sequence:null},value:auditValue}]};
 await adapter.prepareReplace!(ctx,[await wrapper(withAudit)]);
 await assert.rejects(async()=>adapter.prepareReplace!(ctx,[await wrapper({...withAudit,auditRecords:[{...withAudit.auditRecords[0],value:{...auditValue,message:'changed'}}]})]));
 const auditWrapper=await wrapper(withAudit);assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...auditWrapper,value:{...withAudit,auditRecords:[{...withAudit.auditRecords[0],ref:{...withAudit.auditRecords[0].ref,workspaceRevision:2}}]}}]}));
});
test('ack coverage, snapshots, schedule identities and terminal-only occurrence history are exact',async()=>{
 for(const [key,value] of [
  ['review_acknowledgements',{...ack,snapshotHash:hash}],['review_acknowledgements',{...ack,coveredFactIds:['foreign']}],['review_acknowledgements',{...ack,scope:{...ack.scope,filterDigest:'b'.repeat(64)}}],
  ['automation_schedules',{...schedule,projectIds:['foreign']}],['automation_occurrences',{...occurrence,scheduleId:'foreign'}],['automation_occurrences',{...occurrence,kind:'weekly_review'}],['notification_events',{...notification,snapshotRef:{id:'snapshot',hash}}],['review_analysis_runs',{...analysis,snapshotHash:hash}],['review_analysis_runs',{...analysis,suggestions:[{...analysis.suggestions[0],factIds:['foreign']}]}],
 ] as const){const ctx=await fixture();await replace(ctx,key,value);assert.throws(()=>validateReviewModuleReferences(ctx));}
 const adapter=reviewExportAdapters.find(a=>a.key==='automation_occurrences')!,occurrenceWrapper=await wrapper(occurrence);assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...occurrenceWrapper,value:{...occurrence,outcome:'pending'}}]}));
});
test('exact evidence and source versions are required rather than trusting frozen prose or model citations',async()=>{
 const ctx=await fixture();const cited={...snapshot,facts:[{...snapshot.facts[0],evidenceRefs:[{id:'missing',version:2}]}]};await replace(ctx,'review_snapshots',cited);assert.throws(()=>validateReviewModuleReferences(ctx));
 const other=await fixture();await replace(other,'review_snapshots',{...snapshot,sourceSet:[{id:'foreign-observation',contentDigest:hash}]});assert.throws(()=>validateReviewModuleReferences(other));
 const model=await fixture();await replace(model,'review_analysis_runs',{...analysis,suggestions:[{...analysis.suggestions[0],evidenceRefs:[{id:'missing',version:1}]}]});assert.throws(()=>validateReviewModuleReferences(model));
});
test('real SQLite export respects each frozen operational watermark, including imported sequence zero',async()=>{
 const f=database();try{
  for(const [table,value] of [['review_snapshots',snapshot],['automation_schedules',schedule]] as const){const row=await wrapper(value),columns=moduleColumnNames(table),projection=await moduleProjection(table,row.id,value as unknown as JsonValue);f.sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash${columns.map(c=>','+c).join('')}) VALUES(?,?,2,?,?${columns.map(()=>',?').join('')})`).run('synthetic-owner',row.id,canonical(value),row.contentHash,...columns.map(c=>projection[c]));}
  for(const adapter of reviewExportAdapters.filter(a=>['review_snapshots','review_analysis_runs','notification_events','automation_occurrences'].includes(a.key))){const original=records[reviewExportAdapters.indexOf(adapter)];for(const [suffix,sequence] of [['import',0],['included',5],['later',6]] as const){const value={...original,id:`${original.id}-${suffix}`,...(adapter.key==='notification_events'?{dedupKey:await contentHash(suffix)}:{}),...(adapter.key==='automation_occurrences'?{dueAt:`2026-10-${sequence+19}T12:00:00.000Z`}:{})},row=await wrapper(value),table=adapter.key as Parameters<typeof moduleColumnNames>[0],columns=moduleColumnNames(table),projection=await moduleProjection(table,row.id,value as unknown as JsonValue);projection.stream_sequence=sequence;f.sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash${columns.map(c=>','+c).join('')}) VALUES(?,?,2,?,?${columns.map(()=>',?').join('')})`).run('synthetic-owner',row.id,canonical(value),row.contentHash,...columns.map(c=>projection[c]));}
   const context={userId:'synthetic-owner',sourceRevision:1,query:ownerReader(f.db,'synthetic-owner'),db:f.db,operationalWatermarks:{reviews:5,notifications:5,automations:5}} satisfies ExportContext;
   const exported=await adapter.exportRows(context);assert.deepEqual(exported.map(row=>(row as {id:string}).id).filter(id=>id!=='snapshot'),[`${original.id}-import`,`${original.id}-included`]);assert.equal(canonical(exported).includes('stream_sequence'),false);assert.deepEqual(await adapter.exportRows({...context,userId:'foreign',query:ownerReader(f.db,'foreign')}),[]);
  }
 }finally{f.sqlite.close();}
});
test('embedded frozen decision must equal its portable immutable version without live planning rewrites',async()=>{
 const ctx=await fixture();const evidence={id:'evidence',version:1,basis:'owner-statement',scope:'implementation',title:'Historical evidence',statement:'Owner statement',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
 const decision={id:'decision',version:1,title:'Historical decision',question:'What next?',options:[],selectedOptionId:null,rationale:'',status:'draft' as const,decidedAt:null,reviewOn:null,subjects:[{type:'project' as const,id:projectId}],evidenceRefs:[{id:'evidence',version:1}],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null};
 const composite=async(id:string,record:unknown)=>{const value={kind:'version',physicalId:id,record};return {id,rowRevision:1,contentHash:await contentHash(canonical(value)),value};};
 ctx.modules.evidence={schemaVersion:1,records:[await composite('evidence-version',evidence)]};
 ctx.modules.decisions={schemaVersion:1,records:[await composite('decision-version',decision)]};
 const historical={...snapshot,decisionVersions:[decision],facts:[{...snapshot.facts[0],decisionRefs:[{id:'decision',version:1}],evidenceRefs:[{id:'evidence',version:1}]}]};
 const historicalHash=await contentHash(canonical(historical));await replace(ctx,'review_snapshots',historical);await replace(ctx,'review_acknowledgements',{...ack,snapshotHash:historicalHash});await replace(ctx,'review_analysis_runs',{...analysis,snapshotHash:historicalHash});await replace(ctx,'notification_events',{...notification,snapshotRef:{id:'snapshot',hash:historicalHash}});await replace(ctx,'automation_occurrences',{...occurrence,resultRef:{kind:'review',id:'snapshot',hash:historicalHash}});
 validateReviewModuleReferences(ctx);
 await replace(ctx,'review_snapshots',{...historical,decisionVersions:[{...decision,title:'Forged historical title'}]});assert.throws(()=>validateReviewModuleReferences(ctx));
});
