import test from 'node:test';
import assert from 'node:assert/strict';
import {baselineExportAdapters,baselineReferenceDescriptors,validateBaselineModuleReferences} from '../lib/baselines/module.ts';
import {canonicalJsonValue} from '../lib/audit-events.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {reviewSourceWatermark} from '../lib/reviews/freshness.ts';
import {PROJECT_BASELINES} from '../lib/project-baselines.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {database} from './helpers/sqlite.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import type {ImportContext,ExportContext} from '../lib/workspace-export.ts';
import type {ProjectBaselineRevision} from '../lib/baselines/contracts.ts';
import type {ReviewSnapshot} from '../lib/reviews/contracts.ts';
const now='2026-10-18T12:00:00.000Z',hash='a'.repeat(64),planning=workspaceFixture(),adapter=baselineExportAdapters[0];
async function wrap<T extends {id:string}>(value:T){return {id:value.id,rowRevision:1,contentHash:await contentHash(canonical(value)),value};}
async function composite(id:string,record:unknown){const value={kind:'version',physicalId:id,record};return {id,rowRevision:1,contentHash:await contentHash(canonical(value)),value};}
async function fixture(){
 const payload={text:'Historical source statement'},observation={id:'observation',sourceId:'source',externalId:'document',sourceRevision:'revision',sourceUpdatedAt:null,observedAt:now,title:'Historical source',canonicalUrl:null,contentDigest:await contentHash(canonical(payload)),payload,origin:'provider-read'},observationRefs=[{id:observation.id,contentDigest:observation.contentDigest}],evidenceRefs=[{id:'evidence',version:1}],decisionRefs=[{id:'decision',version:1}];
 const evidence={id:'evidence',version:1,basis:'owner-statement',scope:'implementation',title:'Historical evidence',statement:'Owner context only',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
 const decision={id:'decision',version:1,title:'Historical decision',question:'What next?',options:[],selectedOptionId:null,rationale:'',status:'draft' as const,decidedAt:null,reviewOn:null,subjects:[{type:'project' as const,id:'p1'}],evidenceRefs,sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null};
 const project={id:'p1',name:'Original frozen project'},projectHash=await contentHash(canonical(project)),planningRef={kind:'project' as const,id:'p1',workspaceRevision:1,contentHash:projectHash};
 const snapshot:ReviewSnapshot={id:'snapshot',scope:{projectIds:['p1'],filterDigest:hash},workspaceRevision:1,operationalWatermarks:{sources:1},sourceWatermark:await reviewSourceWatermark(observationRefs),sourceSet:observationRefs,generatedAt:now,facts:[{id:'fact',projectId:'p1',kind:'progress',text:'Historical documented context',evidenceRefs,decisionRefs,observationRefs,planningRefs:[planningRef],auditRefs:[],observedAt:null,sourceUpdatedAt:null,basis:'documented',href:'/?view=review'}],unknowns:[],decisionVersions:[decision],planningRecords:[{...planningRef,value:project}],auditRecords:[],coverage:{complete:true,remainingFacts:0,includedFactIds:['fact'],includedEventIds:[]},modelRunId:null};
 const snapshotRow=await wrap(snapshot),revision:ProjectBaselineRevision={id:'revision-one',projectId:'p1',parent:{kind:'initial',projectHash},recordedAt:now,reviewedAsOf:now,snapshotRef:{id:snapshot.id,hash:snapshotRow.contentHash},summary:'Owner-reviewed historical context',accomplishments:['Documented work'],blockers:['Physical acceptance unknown'],unknowns:['Provider freshness is not current authority'],ownerReason:'Record reviewed context only',observationRefs,evidenceRefs,decisionRefs,sourceWatermark:await reviewSourceWatermark(observationRefs),sourceFreshness:'verified-current'};
 const first=await wrap(revision),second=await wrap({...revision,id:'revision-two',parent:{kind:'revision' as const,id:first.id,hash:first.contentHash},summary:'Second historical context'});
 const context:ImportContext={planning:structuredClone(planning),modules:{project_baseline_revisions:{schemaVersion:1,records:[first,second]},review_snapshots:{schemaVersion:1,records:[snapshotRow]},source_observations:{schemaVersion:1,records:[await wrap(observation)]},evidence:{schemaVersion:1,records:[await composite('evidence-version',evidence)]},decisions:{schemaVersion:1,records:[await composite('decision-version',decision)]}}};return {context,revision,first,second,snapshot,observation,decision};
}
test('strict portable revisions roundtrip immutable IDs, parent hashes and historical freshness without private authority',async()=>{
 const f=await fixture(),staticBefore=canonical(PROJECT_BASELINES);assert.equal(baselineExportAdapters.length,1);assert.equal(adapter.legacyOptional,true);validateBaselineModuleReferences(f.context);
 const parsed=adapter.parseAndMigrate(f.context.modules.project_baseline_revisions),split=await adapter.prepareReplace!(f.context,parsed);assert.deepEqual(split,[{table:'project_baseline_revisions',records:[{id:f.first.id,value:f.first.value},{id:f.second.id,value:f.second.value}]}]);
 assert.deepEqual(await adapter.prepareReplace!({planning,modules:{}},[]),[{table:'project_baseline_revisions',records:[]}]);validateBaselineModuleReferences({planning,modules:{}});
 assert.equal((split[0].records[0].value as unknown as ProjectBaselineRevision).sourceFreshness,'verified-current');assert.equal(canonical(split).includes('sourceProofs'),false);assert.equal(canonical(split).includes('head'),false);assert.equal(canonical(PROJECT_BASELINES),staticBefore);
 const refs=baselineReferenceDescriptors[0].references(f.second.value);assert.equal(baselineReferenceDescriptors[0].entityKind,'baseline-revision');for(const kind of ['project','review-snapshot','baseline-revision','source-observation','evidence','decision'])assert.ok(refs.some(r=>r.kind===kind));
});
test('unknown versions, unsafe/private fields, duplicate IDs, row identity and digests fail closed',async()=>{
 const f=await fixture();for(const key of ['head','sourceProofs','grant','principal','activation','credential'])assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...f.first,value:{...f.revision,[key]:'private'}}]}));
 assert.throws(()=>adapter.parseAndMigrate({schemaVersion:2,records:[]}));assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[f.first,f.first]}));assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...f.first,id:'foreign'}]}));assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[{...f.first,privateHead:'foreign'}]}));await assert.rejects(async()=>adapter.prepareReplace!(f.context,[{...f.first,contentHash:hash}]));
});
test('missing, wrong-project, wrong-hash and cyclic parents reject without rewriting historical bodies',async()=>{
 const f=await fixture();for(const parent of [{kind:'revision',id:'missing',hash:f.first.contentHash},{kind:'revision',id:f.first.id,hash}]){const second=await wrap({...f.second.value,parent});assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[f.first,second]}));}
 const foreign=await wrap({...f.first.value,projectId:'foreign-project'});assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:[foreign,{...f.second,value:{...f.second.value,parent:{kind:'revision',id:foreign.id,hash:foreign.contentHash}}}]}));
 const cycle=[{...f.first,contentHash:hash,value:{...f.first.value,parent:{kind:'revision',id:f.second.id,hash:f.second.contentHash}}},{...f.second,value:{...f.second.value,parent:{kind:'revision',id:f.first.id,hash}}}];assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:cycle}),/cycle/);
 const before=canonical(f.first.value);f.context.planning.projects[0].name='A later live project rename';validateBaselineModuleReferences(f.context);await adapter.prepareReplace!(f.context,f.context.modules.project_baseline_revisions.records);assert.equal(canonical(f.first.value),before);
});
test('bundled parent validates the original October 17 package, and selected-source SHA uses shared exact watermark',async()=>{
 const f=await fixture(),bundled=PROJECT_BASELINES[0],record=await wrap({...f.revision,id:'bundled-child',parent:{kind:'bundled' as const,baselineId:bundled.id,key:bundled.key,packageHash:await contentHash(canonical(bundled))}});
 await adapter.prepareReplace!(f.context,[record]);await assert.rejects(async()=>adapter.prepareReplace!(f.context,[await wrap({...record.value,parent:{...record.value.parent,packageHash:hash}})]));await assert.rejects(async()=>adapter.prepareReplace!(f.context,[await wrap({...f.revision,sourceWatermark:hash})]));
});
test('snapshot scope/hash and exact selected evidence/decision/source versions fail closed',async()=>{
 const f=await fixture();for(const patch of [{projectId:'foreign'}, {snapshotRef:{id:'snapshot',hash}}, {observationRefs:[{id:'observation',contentDigest:hash}]}, {evidenceRefs:[{id:'evidence',version:2}]}, {decisionRefs:[{id:'decision',version:2}]}])await assert.rejects(async()=>adapter.prepareReplace!(f.context,[await wrap({...f.revision,...patch})]));
 const changed={...f.context,modules:{...f.context.modules,decisions:{schemaVersion:1,records:[await composite('decision-version',{...f.decision,title:'Tampered frozen decision'})]}}};await assert.rejects(async()=>adapter.prepareReplace!(changed,[f.first]));
 const forged={...f.context,modules:{...f.context.modules,source_observations:{schemaVersion:1,records:[await wrap({...f.observation,payload:{text:'Changed payload'}})]}}};await assert.rejects(async()=>adapter.prepareReplace!(forged,[f.first]));
});
test('actual owner-scoped SQLite export includes only immutable portable rows, never private head/proof tables',async()=>{
 const f=await fixture(),db=database();try{
  db.sqlite.prepare('INSERT INTO project_baseline_heads(user_id,project_id,revision_id,content_hash,recorded_at) VALUES(?,?,?,?,?)').run('owner','p1',f.first.id,f.first.contentHash,now);
  for(const row of [f.first,f.second]){const projection=await moduleProjection('project_baseline_revisions',row.id,canonicalJsonValue(row.value)),columns=moduleColumnNames('project_baseline_revisions');db.sqlite.prepare(`INSERT INTO project_baseline_revisions(user_id,id,row_revision,payload_json,content_hash,${columns.join(',')}) VALUES(?,?,1,?,?,${columns.map(()=>'?').join(',')})`).run('owner',row.id,canonical(row.value),row.contentHash,...columns.map(c=>projection[c]));}
  const context={userId:'owner',sourceRevision:1,query:ownerReader(db.db,'owner'),db:db.db} satisfies ExportContext;const exported=await adapter.exportRows(context);assert.deepEqual(exported,[f.first,f.second]);assert.equal(Object.hasOwn(exported[0] as object,'head'),false);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM project_baseline_heads').get()!.n,1);assert.deepEqual(await adapter.exportRows({...context,userId:'foreign',query:ownerReader(db.db,'foreign')}),[]);
 }finally{db.sqlite.close();}
});
test('selected citations must belong to the baseline project facts, not merely another frozen project or unused snapshot versions',async()=>{
 const f=await fixture();for(const field of ['observationRefs','evidenceRefs','decisionRefs']as const){const changed={...f.snapshot,facts:[{...f.snapshot.facts[0],[field]:[]}]},snapshotRow=await wrap(changed),revision=await wrap({...f.revision,snapshotRef:{id:changed.id,hash:snapshotRow.contentHash}}),context={...f.context,modules:{...f.context.modules,review_snapshots:{schemaVersion:1,records:[snapshotRow]}}};await assert.rejects(async()=>adapter.prepareReplace!(context,[revision]));}
});
