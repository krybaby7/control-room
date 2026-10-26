import test from 'node:test';
import assert from 'node:assert/strict';
import type {Workspace} from '../lib/types.ts';
import {compactPlanning,measurePlanning,measureValidatedPlanning} from '../lib/workspace-migrations.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {workspaceFixture,projectFixture,milestoneFixture,taskFixture,legacyPlanningFixture,FIXTURE_AT} from './helpers/workspace.ts';

// Independent projection oracle: actual JSON serialization, preserving the
// historical spread rules and omitting only declared generated v5 defaults.
function reference(workspace:Workspace){
 const positions=new Map<string,number>();
 const base={...workspace};if(!base.areas?.length)delete base.areas;
 const compact={...base,
  projects:workspace.projects.map(project=>Object.fromEntries(Object.entries(project).filter(([key,value])=>!((key==='archivedAt'||key==='personalRepositoryKey')&&value===null||key==='framing'&&value===''||key==='includeTaskPlanInBriefings'&&value===false)))),
  milestones:workspace.milestones.map(milestone=>{const next=positions.get(milestone.projectId)??0;positions.set(milestone.projectId,next+1);const copy:Partial<typeof milestone>={...milestone};if(copy.archivedAt===null)delete copy.archivedAt;if(copy.sortKey===next)delete copy.sortKey;return copy;}),
  tasks:workspace.tasks.map(task=>{const copy:Partial<typeof task>={...task};if(copy.weeklyWeek===null)delete copy.weeklyWeek;if(copy.archivedFromStatus===null)delete copy.archivedFromStatus;if(copy.estimateMinutes===null)delete copy.estimateMinutes;if(copy.areaId===null)delete copy.areaId;if(copy.workType==='other')delete copy.workType;return copy;})};
 const {schemaVersion:_version,...content}=compact;void _version;
 const tasks=content.tasks.map(task=>{const {weeklyWeek:_week,archivedFromStatus:_previous,...owner}=task;void _week;void _previous;return owner;});
 const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
 return {contentBytes:bytes({...content,tasks}),serializedBytes:bytes(compact)};
}
function check(workspace:Workspace,plainData=true){
 const snapshot=JSON.stringify(workspace),compact=JSON.stringify(compactPlanning(workspace));
 assert.deepEqual(measurePlanning(workspace),reference(workspace));
 if(plainData)assert.deepEqual(measureValidatedPlanning(workspace),reference(workspace));
 assert.equal(measurePlanning(workspace).serializedBytes,new TextEncoder().encode(compact).length);
 assert.equal(JSON.stringify(workspace),snapshot);assert.equal(JSON.stringify(compactPlanning(workspace)),compact);
}
function fixture(){return workspaceFixture({
 projects:[projectFixture(),projectFixture({id:'p2',name:'Second project',archivedAt:FIXTURE_AT})],
 milestones:[milestoneFixture(),milestoneFixture({id:'m2',projectId:'p2',sortKey:0}),milestoneFixture({id:'m3',sortKey:1,archivedAt:FIXTURE_AT}),milestoneFixture({id:'m4',projectId:'p2',sortKey:9007199254740991}),milestoneFixture({id:'m5',sortKey:9})],
 tasks:[taskFixture('normal'),taskFixture('pinned',{weekly:true,weeklyWeek:'2026-10-12',estimateMinutes:10080}),taskFixture('archived',{status:'archived',archivedFromStatus:'done',completedAt:FIXTURE_AT}),taskFixture('nonnull',{estimateMinutes:1})],
 captures:[{id:'capture',title:'Capture',body:'Owner body',projectId:null,kind:'idea',sourceUrl:null,status:'inbox',createdAt:FIXTURE_AT,convertedTaskId:null}],
 activity:[{id:'activity',text:'Owner activity',at:FIXTURE_AT,projectId:null}],
});}
test('exact measurement matches historical projection for schemas 1–5 before and after strict migration',()=>{
 const current=fixture();for(const version of [1,2,3,4] as const){
  const raw=version===4?current:legacyPlanningFixture(current,version);check(raw);check(parseWorkspaceExport(raw,FIXTURE_AT));
 }
 check(workspaceFixture({projects:[]}));check(parseWorkspaceExport(current,FIXTURE_AT));
});
test('Unicode, JSON escaping and generated-name owner text are never excluded or undercounted',()=>{
 const texts=['','ASCII weeklyWeek archivedFromStatus schemaVersion sortKey archivedAt estimateMinutes','مرحبا 測試 😀 e\u0301','\ud800','\udfff','a\ud800b\udfffc','\u0000\b\t\n\r\f"\\/','\u2028\u2029','"weeklyWeek":null,"archivedFromStatus":"done"'];
 for(const text of texts){const w=fixture();w.tasks[0].id='task-測😀\ud800"\\';w.projects[0].description=text;w.projects[0].goal=text;w.milestones[0].description=text;w.milestones[0].acceptance=text;w.tasks[0].notes=text;w.tasks[0].evidence=text;w.captures[0].body=text;w.activity[0].text='Event '+text;check(w);check(parseWorkspaceExport(w,FIXTURE_AT));}
});
test('optional absence, own undefined/null, default positions and property order retain exact old lengths',()=>{
 const options=[undefined,null,'2026-10-12'] as const;
 for(const week of options)for(const previous of [undefined,null,'todo','done'] as const)for(const estimate of [undefined,null,1,10080])for(const order of [false,true]){
  const w=fixture(),task=w.tasks[0];task.weeklyWeek=week;task.archivedFromStatus=previous;task.estimateMinutes=estimate as number|null;
  if(week===undefined)delete task.weeklyWeek;if(previous===undefined)delete task.archivedFromStatus;if(estimate===undefined)delete (task as Partial<typeof task>).estimateMinutes;
  if(order){w.tasks=w.tasks.map(row=>Object.fromEntries(Object.entries(row).reverse()) as unknown as typeof row);w.projects=w.projects.map(row=>Object.fromEntries(Object.entries(row).reverse()) as unknown as typeof row);w.milestones.reverse();}
  check(w);
 }
 const ownUndefined=fixture();Object.assign(ownUndefined.tasks[0],{weeklyWeek:undefined,archivedFromStatus:undefined,estimateMinutes:undefined});Object.assign(ownUndefined.projects[0],{archivedAt:undefined});Object.assign(ownUndefined.milestones[0],{archivedAt:undefined,sortKey:undefined});check(ownUndefined);
 const w=fixture();delete (w.projects[0] as Partial<typeof w.projects[number]>).archivedAt;delete (w.milestones[0] as Partial<typeof w.milestones[number]>).archivedAt;delete (w.milestones[0] as Partial<typeof w.milestones[number]>).sortKey;check(w);
});
test('interleaved milestone project positions, nondefault numeric encodings and generated history remain exact',()=>{
 const w=fixture();for(const key of [0,-0,1,9,10,100,1e6,Number.MAX_SAFE_INTEGER]){w.milestones[0].sortKey=key;check(w);}
 for(const week of [null,'2026-10-12','測😀\ud800"\\'])for(const previous of [null,'todo','done']){w.tasks[0].weeklyWeek=week;w.tasks[0].archivedFromStatus=previous as 'todo'|'done'|null;check(w);}
 for(let seed=1;seed<=128;seed++){
  const value=fixture();value.milestones=value.milestones.map((row,index)=>({...row,sortKey:(seed+index)%4===0?index*seed:row.sortKey,archivedAt:(seed+index)%3===0?FIXTURE_AT:null}));
  value.tasks=value.tasks.map((row,index)=>({...row,estimateMinutes:(seed+index)%2===0?null:seed,notes:'測😀\ud800"\\'.repeat(seed%19),weeklyWeek:(seed+index)%3===0?'2026-10-12':null,archivedFromStatus:(seed+index)%4===0?'done':null}));check(value);
 }
});
test('legacy projection remains the fallback for accessors, nonenumerable/inherited identity and custom serialization',()=>{
 const variants:Array<(w:Workspace)=>void>=[
  w=>{Object.defineProperty(w.tasks[0],'notes',{enumerable:true,get:()=> 'Accessor text 測'});},
  w=>{Object.defineProperty(w.tasks[0],'id',{value:'hidden',enumerable:false});},
  w=>{Object.setPrototypeOf(w.tasks[0],{id:'inherited'});},
  w=>{Object.defineProperty(w.projects[0],'toJSON',{value:()=>({id:'custom',name:'Custom serialization'})});},
  w=>{Object.defineProperty(w,'projects',{value:w.projects,enumerable:false});},
  w=>{Object.defineProperty(w.tasks,'0',{enumerable:true,get:()=>taskFixture('array-accessor')});},
  w=>{Object.defineProperty(w.captures[0],'body',{enumerable:true,get:()=> 'Capture accessor'});},
 ];
 for(const variant of variants){const w=fixture();variant(w);check(w,false);}
});
test('near-cap and over-cap inputs keep exact content and serialized bytes without mutating immutable records',()=>{
 const w=workspaceFixture({tasks:Array.from({length:1700},(_,i)=>taskFixture('capacity-'+i,{notes:'Synthetic measurement fixture.'})),captures:Array.from({length:850},(_,i)=>({id:'capture-'+i,title:'Capture',body:'Synthetic metadata.',projectId:null,kind:'idea',sourceUrl:null,status:'inbox',createdAt:FIXTURE_AT,convertedTaskId:null}))});
 let remaining=1_000_000-reference(w).contentBytes;assert.ok(remaining>0);for(const task of w.tasks){const amount=Math.min(10000-task.notes.length,remaining);task.notes+='x'.repeat(amount);remaining-=amount;}assert.equal(remaining,0);assert.equal(reference(w).contentBytes,1_000_000);check(w);assert.deepEqual(parseWorkspaceExport(w),{...w,schemaVersion:5,areas:[],tasks:w.tasks.map(task=>({...task,areaId:null,workType:'other'}))});
 const last=w.tasks.at(-1)!;const saved=last.notes;last.notes=saved.slice(0,-1);assert.equal(reference(w).contentBytes,999_999);check(w);assert.deepEqual(parseWorkspaceExport(w),{...w,schemaVersion:5,areas:[],tasks:w.tasks.map(task=>({...task,areaId:null,workType:'other'}))});last.notes=saved+'x';assert.equal(reference(w).contentBytes,1_000_001);check(w);assert.throws(()=>parseWorkspaceExport(w),error=>error instanceof Error&&error.message==='Workspace exceeds the 1 MB legacy user-content storage limit.');
 last.notes=saved+'ع';assert.equal(reference(w).contentBytes,1_000_002);check(w);assert.throws(()=>parseWorkspaceExport(w),/user-content storage limit/);
 for(const rows of [w.projects,w.milestones,w.tasks,w.captures,w.activity]){for(const row of rows)Object.freeze(row);Object.freeze(rows);}Object.freeze(w);check(w);
});

test('serialized ceiling neighbors retain exact counts and the existing content-first parser failure',()=>{
 for(const target of [1_249_999,1_250_000,1_250_001]){
  const w=workspaceFixture({tasks:Array.from({length:200},(_,i)=>taskFixture('serialized-'+i,{notes:''}))});
  let remaining=target-reference(w).serializedBytes;
  for(const task of w.tasks){const amount=Math.min(10000,remaining);task.notes='x'.repeat(amount);remaining-=amount;}
  assert.equal(remaining,0);assert.equal(reference(w).serializedBytes,target);check(w);
  // Under the current task count/history bounds, content already exceeds 1MB
  // here. The earlier error must retain priority over the serialized ceiling.
  assert.throws(()=>parseWorkspaceExport(w),error=>error instanceof Error&&error.message==='Workspace exceeds the 1 MB legacy user-content storage limit.');
 }
});

test('v5 area identity and classification defaults match an independent projection byte for byte',()=>{
 const w=parseWorkspaceExport(fixture(),FIXTURE_AT);
 w.areas=[{id:'area-測😀',projectId:'p1',name:'Owner area "測"',aliases:['weeklyWeek areaId workType'],order:19,archivedAt:FIXTURE_AT}];
 w.tasks[0].areaId=w.areas[0].id;w.tasks[0].workType='review';
 w.tasks[1].notes='areas areaId workType "other" null';
 check(w);check(parseWorkspaceExport(w,FIXTURE_AT));
 const original=reference(w);w.tasks[0].areaId=null;w.tasks[0].workType='other';
 assert.ok(reference(w).contentBytes<original.contentBytes);check(w);
 w.areas=[];check(w);delete w.areas;check(w);
});
test('v5 serialized 1.875 MB ceiling neighbors retain exact counts and content-first validation',()=>{
 for(const target of [1_874_999,1_875_000,1_875_001]){
  const w=parseWorkspaceExport(workspaceFixture({tasks:Array.from({length:220},(_,i)=>taskFixture('v5-serialized-'+i,{notes:''}))}));
  let remaining=target-reference(w).serializedBytes;
  for(const task of w.tasks){const amount=Math.min(10000,remaining);task.notes='x'.repeat(amount);remaining-=amount;}
  assert.equal(remaining,0);assert.equal(reference(w).serializedBytes,target);check(w);
  assert.throws(()=>parseWorkspaceExport(w),error=>error instanceof Error&&error.message==='Workspace exceeds the 1.5 MB user-content storage limit.');
 }
});

test('framing and folder mapping count owner bytes while generated framing defaults retain historical storage',()=>{
 const w=parseWorkspaceExport(fixture());const before=reference(w);check(w);
 w.projects[0].framing='  Purpose ع😀\nStanding rules.  ';w.projects[0].includeTaskPlanInBriefings=true;w.projects[0].personalRepositoryKey='folder_key';
 const after=reference(w);assert.ok(after.contentBytes>before.contentBytes);check(w);check(parseWorkspaceExport(w));
 const raw=structuredClone(w);for(const p of raw.projects){delete p.framing;delete p.includeTaskPlanInBriefings;delete p.personalRepositoryKey;}
 assert.equal(JSON.stringify(compactPlanning(parseWorkspaceExport(raw))),JSON.stringify(compactPlanning(raw)));
});
