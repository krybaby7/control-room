import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parseRecurrenceRule,createRecurrenceProposal,type RecurrenceRule} from '../lib/recurrence.ts';
const now='2026-10-22T10:00:00.000Z';
function fixture(){const workspace=createSeedWorkspace(now),projectId=workspace.projects[0].id;workspace.areas=[{id:'review-area',projectId,name:'Review',aliases:[],order:0,archivedAt:null}];const rule:RecurrenceRule={id:'bb089a3a-0147-46f4-bd98-8a9b2118cedd',startDate:'2026-10-22',endDate:null,enabled:true,pattern:{frequency:'daily',interval:1},template:{areaId:'review-area',workType:'review',estimateMinutes:30,projectId,milestoneId:null,title:'Review work',notes:'Explicit owner classification',horizon:'next',priority:'normal',blocker:'',sourceUrl:null}};return {workspace,rule};}
test('recurrence preserves explicit classification and legacy template absence without changing stored wire fields',()=>{
 const {workspace,rule}=fixture();assert.deepEqual(parseRecurrenceRule(rule),rule);const before=structuredClone(rule),proposal=createRecurrenceProposal(rule,'2026-10-22',workspace,now);assert.equal(proposal.status,'proposed');if(proposal.status==='proposed'){assert.equal(proposal.task.areaId,'review-area');assert.equal(proposal.task.workType,'review');assert.equal(proposal.task.status,'proposed');assert.equal(proposal.task.weekly,false);}assert.deepEqual(rule,before);
 const legacy=structuredClone(rule);delete legacy.template.areaId;delete legacy.template.workType;assert.deepEqual(parseRecurrenceRule(legacy),legacy);const migrated=createRecurrenceProposal(legacy,'2026-10-22',workspace,now);assert.equal(migrated.status,'proposed');if(migrated.status==='proposed'){assert.equal(migrated.task.areaId,null);assert.equal(migrated.task.workType,'other');}
});
test('recurrence rejects invalid classification and pauses proposals for missing, foreign or archived areas',()=>{
 const {workspace,rule}=fixture();assert.throws(()=>parseRecurrenceRule({...rule,template:{...rule.template,workType:'automatic'}}));assert.throws(()=>parseRecurrenceRule({...rule,template:{...rule.template,areaId:''}}));
 for(const projectId of ['missing-project',workspace.projects[1].id]){const foreign=structuredClone(workspace);foreign.areas![0].projectId=projectId;assert.deepEqual(createRecurrenceProposal(rule,'2026-10-22',foreign,now),{status:'attention',reason:'missing-area'});}
 const archived=structuredClone(workspace);archived.areas![0].archivedAt=now;assert.deepEqual(createRecurrenceProposal(rule,'2026-10-22',archived,now),{status:'attention',reason:'archived-area'});
});
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {planningExportAdapters,planningReferenceDescriptors} from '../lib/planning-module.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle} from '../lib/workspace-export.ts';
test('recurrence commands reject missing and foreign area assignments atomically and export typed references',async()=>{
 const {workspace,rule}=fixture(),{db,sqlite}=database();try{
  workspace.areas!.push({id:'foreign-area',projectId:workspace.projects[1].id,name:'Foreign',aliases:[],order:0,archivedAt:null},{id:'archived-area',projectId:workspace.projects[0].id,name:'Archived',aliases:[],order:1,archivedAt:now});
  await loadWorkspace(db,'owner',()=>workspace,now);const {id:_id,...input}=rule;void _id;
  const send=(value:typeof input,mutationId:string)=>executeWorkspaceCommand('owner',{protocolVersion:1,expectedRevision:1,mutationId,command:{type:'recurrence.create',rule:value}},{db,handlers:workspaceHandlers,now:()=>now});
  for(const areaId of ['missing','foreign-area','archived-area'])await assert.rejects(send({...input,template:{...input.template,areaId}},`area-recurrence-${areaId}`),/missing-area|archived-area/);
  assert.equal((await readCurrent(db,'owner')).revision,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM recurrence_rules').get()!.n,0);
  const result=await send(input,'valid-area-recurrence-0001');assert.equal(result.status,'committed');
  const descriptor=planningReferenceDescriptors.find(row=>row.key==='recurrence_rules')!;assert.ok(descriptor.references(rule).some(ref=>ref.kind==='area'&&ref.id==='review-area'));
  const bundle=await exportWorkspaceBundle(db,'owner');assert.deepEqual(parseWorkspaceBundle(bundle).planning.areas,workspace.areas);
  const adapter=planningExportAdapters.find(row=>row.key==='recurrence_rules')!;const invalid=structuredClone(bundle);invalid.planning.areas=[];assert.throws(()=>adapter.validateReferences!({planning:invalid.planning,modules:invalid.modules},[]),/missing-area|archived-area/);
  const archived=structuredClone(bundle);archived.planning.areas![0].archivedAt=now;assert.doesNotThrow(()=>adapter.validateReferences!({planning:archived.planning,modules:archived.modules},[]));
 }finally{sqlite.close();}
});
