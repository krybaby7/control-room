import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProjectBriefing,validateBriefingContent,previousLedger,validatePreviousLedger,upgradeBriefing,compactPlan,validateCompactPlan,COMPACT_PLAN_MAX_CHARACTERS,PROJECT_BRIEFING_MAX_CHARACTERS,PREVIOUS_LEDGER_MAX_CHARACTERS} from '../shared/project-briefing.mjs';
import {briefingFixture,briefingFixtureV1,briefingFixtureV2} from './fixtures/briefing.ts';
import {workspaceFixture,projectFixture,taskFixture,milestoneFixture,FIXTURE_AT} from './helpers/workspace.ts';
import * as contract from '../shared/project-briefing.mjs';

test('project framing excludes task records by default and includes them only after explicit opt-in',()=>{
 const workspace=workspaceFixture({projects:[projectFixture({framing:'Purpose\nKeep this scope.'})],milestones:[milestoneFixture()],tasks:[taskFixture('secret-task',{title:'TASK SENTINEL'}),taskFixture('archived',{status:'archived'})]});
 const framing=contract.projectFraming(workspace,'p1',7);
 assert.deepEqual(framing,{projectId:'p1',projectName:workspace.projects[0].name,framing:'Purpose\nKeep this scope.',includeTaskPlan:false,milestones:[],tasks:[],totalMilestones:1,totalTasks:1,workspaceRevision:7});
 assert.ok(!JSON.stringify(framing).includes('TASK SENTINEL'));
 workspace.projects[0].includeTaskPlanInBriefings=true;
 const included=contract.projectFraming(workspace,'p1',8);
 assert.equal(included.tasks[0].title,'TASK SENTINEL');assert.equal(included.milestones.length,1);
 assert.deepEqual(contract.validateProjectFraming(included),included);
 assert.throws(()=>contract.validateProjectFraming({...included,includeTaskPlan:false}));
 assert.throws(()=>contract.validateProjectFraming({...included,framing:'x'.repeat(2501)}));
 assert.throws(()=>contract.validateProjectFraming({...included,totalTasks:0}));
 assert.throws(()=>contract.validateProjectFraming({...included,tasks:[{...included.tasks[0],milestone:5}]}));
});

test('version 3 requires fit or drift while legacy reports project without inventing an assessment',()=>{
 const legacy=briefingFixtureV1(),before=JSON.stringify(legacy),shown=validateProjectBriefing(legacy);
 assert.equal(shown.version,3);assert.match(shown.fitOrDrift,/not assess/i);assert.equal(shown.evidence.framing,null);assert.ok(!Object.hasOwn(shown.evidence,'plan'));assert.equal(JSON.stringify(legacy),before);
 const current=briefingFixture();assert.throws(()=>validateProjectBriefing({...current,fitOrDrift:''}));assert.throws(()=>validateProjectBriefing({...current,fitOrDrift:'x'.repeat(481)}));
});
test('a complete briefing validates and round-trips without extra fields',()=>{
 const value=briefingFixture();assert.deepEqual(validateProjectBriefing(value),value);
 for(const edit of ([v=>{(v as unknown as {extra:number}).extra=1;},v=>{v.run.origin='device' as never;},v=>{v.intentions[0].date='2026-13-01';},v=>{v.run.observedModel='gpt-6.1-sol';},v=>{v.evidence.cloud.status='no-remote';},v=>{v.evidence.chats[0].sessions=0;},v=>{v.run.completedAt='2026-10-21T11:00:00.000Z';},v=>{v.aim='';},v=>{v.status.level='done' as never;},
  v=>{v.links=[{from:'signals',to:'orders'},{from:'orders',to:'signals'}];},v=>{v.links=[{from:'signals',to:'signals'}];},v=>{v.links=[{from:'signals',to:'ghost'}];},v=>{v.aimArea='ghost';},v=>{v.intentions[0].area='ghost';},v=>{v.areas=[...v.areas,{...v.areas[0]}];},v=>{v.areas[0].id='Not A Slug';},
  v=>{v.evidence.previous={runId:v.run.id,until:v.evidence.window.until,intentions:1};},v=>{v.evidence.previous={runId:'33333333-3333-4333-8333-333333333333',until:'2026-10-22T00:00:00.000Z',intentions:1};},v=>{v.evidence.ownerTurns={sessions:0,turns:5,characters:10,earliestAt:null,latestAt:null};},v=>{v.evidence.ownerTurns={sessions:1,turns:1,characters:1,earliestAt:'2026-10-21T08:30:00.000Z',latestAt:'2026-10-12T09:00:00.000Z'};}] as ((v:ReturnType<typeof briefingFixture>)=>void)[])){const broken=briefingFixture();edit(broken);assert.throws(()=>validateProjectBriefing(broken),`edit was accepted: ${edit.toString()}`);}
 const long=briefingFixture({intentions:Array.from({length:24},()=>({date:null,title:'t'.repeat(160),outcome:'o'.repeat(320),state:'open' as const,source:'unknown' as const,area:null,bend:{from:'f'.repeat(200),to:'t'.repeat(200),why:'w'.repeat(240)},evidence:['e'.repeat(60),'f'.repeat(60),'g'.repeat(60)]})).map((row,i)=>({...row,title:row.title.slice(0,150)+String(i).padStart(10,'0')})),done:Array.from({length:8},()=>'x'.repeat(160)),notDone:Array.from({length:8},()=>'y'.repeat(160))});
 assert.throws(()=>validateProjectBriefing(long),/report size/);
 assert.ok(JSON.stringify(briefingFixture()).length<PROJECT_BRIEFING_MAX_CHARACTERS);
});
test('a saved version 1 briefing still reads and is shown through the version 3 shape',()=>{
 const v1=briefingFixtureV1(),shown=validateProjectBriefing(v1);
 assert.equal(shown.version,3);assert.equal(shown.aim,v1.headline);assert.deepEqual(shown.leftOff,[v1.status.reason]);
 assert.deepEqual(shown.intentions.map(row=>[row.state,row.source,row.date]),[['reached','repository','2026-10-21'],['in-progress','repository','2026-10-20']]);
 assert.deepEqual(shown.needsYou,v1.decisionsNeeded);assert.deepEqual(shown.open,['Reconciliation of results: Review the cloud draft, then merge it after one more test run.']);
 assert.deepEqual(shown.areas,[]);assert.equal(shown.evidence.previous,null);assert.equal(shown.evidence.ownerTurns.turns,0);
 assert.deepEqual(validateProjectBriefing(shown),shown,'the projection is itself a valid version 3 report');
 assert.deepEqual(upgradeBriefing(v1),shown);
 const broken=briefingFixtureV1();broken.headline='';assert.throws(()=>validateProjectBriefing(broken));
});

test('cloud provenance and coverage are additive and reject inconsistent claims',()=>{
 const old=briefingFixture();
 assert.deepEqual(validateProjectBriefing(old),old,'saved version 2 reports remain unchanged');
 const value=briefingFixture();
 value.intentions[1].cloudProvider='claude-cloud';
 value.evidence.cloudTurns=[{provider:'claude-cloud',status:'included',sessions:1,turns:2},{provider:'codex-cloud',status:'not-found',sessions:0,turns:0}];
 assert.deepEqual(validateProjectBriefing(value),value);
 assert.equal(previousLedger(value).intentions[1].cloudProvider,'claude-cloud');
 for(const edit of [
  (v:typeof value)=>{v.intentions[0].cloudProvider='codex-cloud';},
  (v:typeof value)=>{v.intentions[1].cloudProvider='other' as never;},
  (v:typeof value)=>{v.evidence.cloudTurns![0].turns=0;},
  (v:typeof value)=>{v.evidence.cloudTurns![1].turns=1;},
  (v:typeof value)=>{v.evidence.cloudTurns![1]={...v.evidence.cloudTurns![0]};},
  (v:typeof value)=>{v.evidence.cloudTurns![0].sessions=3;},
  (v:typeof value)=>{v.evidence.cloudTurns![0].turns=24;},
 ]){const broken=structuredClone(value);edit(broken);assert.throws(()=>validateProjectBriefing(broken));}
 const modelContent=Object.fromEntries(Object.entries(value).filter(([key])=>!['format','version','project','repository','run','evidence'].includes(key)));
 assert.equal(validateBriefingContent(modelContent).intentions[1].cloudProvider,'claude-cloud');
});
test('the previous ledger is a bounded slice that drops the oldest intentions first',()=>{
 const slice=previousLedger(briefingFixture());
 assert.deepEqual(Object.keys(slice),['runId','until','aim','fitOrDrift','areas','links','aimArea','intentions','open','needsYou']);
 assert.equal(slice.runId,briefingFixture().run.id);assert.equal(slice.until,briefingFixture().evidence.window.until);assert.equal(slice.intentions.length,3);
 assert.deepEqual(validatePreviousLedger(slice),slice);
 const crowded=briefingFixture({intentions:Array.from({length:24},(_,i)=>({date:'2026-10-01',title:`Intention ${i} `+'t'.repeat(140),outcome:'o'.repeat(320),state:'reached' as const,source:'plan' as const,area:null,bend:null,evidence:[]}))});
 const trimmed=previousLedger(crowded);
 assert.ok(trimmed.intentions.length<24&&trimmed.intentions.length>0);assert.ok(JSON.stringify(trimmed).length<=PREVIOUS_LEDGER_MAX_CHARACTERS);assert.equal(trimmed.intentions[0].title.slice(0,11),'Intention 0','newest first is kept');
 assert.throws(()=>validatePreviousLedger({...slice,links:[{from:'orders',to:'signals'},...slice.links]}));
});
test('model content is validated on its own with bounded prose, a one-way map and evidence refs',()=>{
 const content={fitOrDrift:'Not enough evidence to assess.',aim:'Short.',status:{level:'unclear',reason:'Not enough evidence.'},leftOff:[],areas:[],links:[],aimArea:null,intentions:[],open:[],needsYou:[],tried:[],done:[],notDone:[],nextSteps:[],limitations:[]};
 assert.deepEqual(validateBriefingContent(content),content);
 assert.throws(()=>validateBriefingContent({...content,intentions:[{date:null,title:'x',outcome:'o',state:'reached',source:'plan',area:null,bend:null,evidence:['1','2','3','4']}]}));
 assert.throws(()=>validateBriefingContent({...content,aim:'x'.repeat(241)}));
 assert.throws(()=>validateBriefingContent({...content,areas:[{id:'a',name:'A',state:'proven',done:1,total:1,note:'n'},{id:'b',name:'B',state:'built',done:0,total:1,note:'n'}],links:[{from:'a',to:'b'},{from:'b',to:'a'}]}),/links/);
});
test('compact plan keeps open work first, maps milestones and never exceeds its budget',()=>{
 const tasks=[...Array.from({length:45},(_,i)=>taskFixture(`open-${i}`,{title:`Open task ${i} ${'detail '.repeat(12)}`,status:i%3===0?'doing':'todo',milestoneId:i%2?'milestone-1':null,blocker:i===42?'Waiting on a vendor':'',updatedAt:new Date(Date.parse(FIXTURE_AT)+i*1000).toISOString()})),...Array.from({length:15},(_,i)=>taskFixture(`done-${i}`,{title:`Done task ${i}`,status:'done',completedAt:new Date(Date.parse(FIXTURE_AT)-i*3600_000).toISOString()})),taskFixture('archived',{status:'archived'})];
 const workspace=workspaceFixture({projects:[projectFixture({goal:'g'.repeat(500),description:'d'.repeat(400)})],milestones:[milestoneFixture(),milestoneFixture({id:'milestone-2',title:'Later',sortKey:1,status:'achieved',targetDate:'2026-11-01'})],tasks});
 const plan=compactPlan(workspace,'p1',7);
 assert.equal(plan.revision,7);assert.equal(plan.project.goal.length,400);assert.equal(plan.project.description.length,300);
 assert.deepEqual(plan.milestones.map(row=>row.status),['planned','achieved']);
 assert.ok(plan.tasks.length<=40);assert.ok(JSON.stringify(plan).length<=COMPACT_PLAN_MAX_CHARACTERS);
 assert.equal(plan.tasks[0].status,'doing');assert.ok(plan.tasks.every(row=>row.title.length<=120));
 assert.ok(plan.tasks.some(row=>row.milestone===0));assert.ok(plan.tasks.some(row=>row.blocked));
 assert.equal(plan.totals.tasks,60);assert.equal(plan.totals.open,45);assert.equal(plan.totals.done,15);assert.equal(plan.totals.omitted,60-plan.tasks.length);
 assert.deepEqual(validateCompactPlan(plan),plan);
 assert.throws(()=>compactPlan(workspace,'missing',1));
 assert.throws(()=>validateCompactPlan({...plan,tasks:[{...plan.tasks[0],milestone:5}]}));
});

test('saved version 2 projects honestly and strict historical schemas reject modern fields',()=>{
 const old=briefingFixtureV2(),before=JSON.stringify(old),shown=validateProjectBriefing(old);
 assert.equal(shown.version,3);assert.equal(shown.evidence.framing,null);assert.match(shown.fitOrDrift,/not assess/i);assert.deepEqual(shown.intentions,old.intentions);assert.equal(JSON.stringify(old),before);assert.deepEqual(validateProjectBriefing(shown),shown);
 assert.throws(()=>validateProjectBriefing({...old,fitOrDrift:'Invented.'}));
 const slice=previousLedger(shown),historical=Object.fromEntries(Object.entries(slice).filter(([key])=>key!=='fitOrDrift'));
 assert.deepEqual(validatePreviousLedger(historical),slice);
 assert.throws(()=>validatePreviousLedger(Object.assign(Object.create({inherited:'untrusted'}),historical)));
});

test('transport canonicalizes whitespace-only framing while preserving all nonblank text',()=>{
 const base=contract.projectFraming(workspaceFixture({projects:[projectFixture({framing:' \n\t '})]}),'p1',1);
 assert.equal(base.framing,'');assert.equal(contract.validateProjectFraming({...base,framing:' \r\n '}).framing,'');
 const verbatim='  Purpose\n\tKeep exact spacing.  ';
 assert.equal(contract.validateProjectFraming({...base,framing:verbatim}).framing,verbatim);
});

test('a historical report at the character boundary projects into a valid current report',()=>{
 const old=briefingFixtureV2({intentions:Array.from({length:24},()=>({date:null,title:'t'.repeat(160),outcome:'o'.repeat(320),state:'open',source:'unknown',area:null,bend:{from:'f'.repeat(200),to:'t'.repeat(200),why:'w'.repeat(240)},evidence:['e'.repeat(60),'f'.repeat(60),'g'.repeat(60)]}))});
 while(JSON.stringify(old).length>26000){const row=old.intentions.find(row=>row.outcome.length>1);if(row)row.outcome=row.outcome.slice(0,-1);else {const bend=old.intentions.find(row=>row.bend!.why.length>1)!.bend!;bend.why=bend.why.slice(0,-1);}}
 assert.equal(JSON.stringify(old).length,26000);
 const before=JSON.stringify(old),shown=validateProjectBriefing(old);
 assert.deepEqual(validateProjectBriefing(shown),shown);assert.equal(JSON.stringify(old),before);
 assert.throws(()=>validateProjectBriefing({...old,aim:old.aim+'x'}),/report size/);
});

test('a historical report at the byte boundary projects within delivery limits without changing saved text',()=>{
 const old=briefingFixtureV2({intentions:Array.from({length:24},()=>({date:null,title:'界'.repeat(160),outcome:'界'.repeat(320),state:'open',source:'unknown',area:null,bend:{from:'界'.repeat(200),to:'界'.repeat(200),why:'界'.repeat(240)},evidence:[]}))});
 while(Buffer.byteLength(JSON.stringify(old))>54999){const row=old.intentions.find(row=>row.outcome.length>1);if(row)row.outcome=row.outcome.slice(0,-1);else {const bend=old.intentions.find(row=>row.bend!.why.length>1)!.bend!;bend.why=bend.why.slice(0,-1);}}
 for(const boundary of [54999,55000]){
  const saved=structuredClone(old);saved.aim+='x'.repeat(boundary-Buffer.byteLength(JSON.stringify(saved)));
  const before=JSON.stringify(saved);assert.equal(Buffer.byteLength(before),boundary);assert.ok(before.length<=26000);
  const shown=validateProjectBriefing(saved);assert.ok(Buffer.byteLength(JSON.stringify(shown))<=55000);assert.match(shown.fitOrDrift,/shortened/i);assert.deepEqual(validateProjectBriefing(shown),shown);assert.equal(JSON.stringify(saved),before);
  assert.equal(shown.intentions.length,saved.intentions.length);assert.deepEqual(shown.intentions.map(row=>({date:row.date,state:row.state,source:row.source,area:row.area,evidence:row.evidence})),saved.intentions.map(row=>({date:row.date,state:row.state,source:row.source,area:row.area,evidence:row.evidence})));
 }
});

test('legacy byte-boundary shortening retains substantive text in whitespace-padded prose',()=>{
 const old=briefingFixtureV2({limitations:[' '.repeat(199)+'界'],intentions:Array.from({length:24},()=>({date:null,title:'界'.repeat(160),outcome:'界'.repeat(320),state:'open',source:'unknown',area:null,bend:{from:'界'.repeat(200),to:'界'.repeat(200),why:'界'.repeat(240)},evidence:[]}))});
 while(Buffer.byteLength(JSON.stringify(old))>55000){const row=old.intentions.find(row=>row.outcome.length>1);if(row)row.outcome=row.outcome.slice(0,-1);else {const bend=old.intentions.find(row=>row.bend!.why.length>1)!.bend!;bend.why=bend.why.slice(0,-1);}}
 old.aim+='x'.repeat(55000-Buffer.byteLength(JSON.stringify(old)));
 const before=JSON.stringify(old),shown=validateProjectBriefing(old);
 assert.ok(shown.limitations[0].trim());assert.equal(shown.limitations.length,1);assert.match(shown.fitOrDrift,/shortened/);assert.deepEqual(validateProjectBriefing(shown),shown);assert.equal(JSON.stringify(old),before);
});
