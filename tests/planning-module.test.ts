import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {openPlanningCasDatabase} from './helpers/planning-cas-database.ts';
import {Worker} from 'node:worker_threads';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand,type PrepareContext} from '../lib/workspace-transaction.ts';
import {planningHandlers,planningExportAdapters,planningReferenceDescriptors,recurrenceOccurrenceId} from '../lib/planning-module.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {ExportRegistry,exportRegistry,exportWorkspaceBundle,parseWorkspaceBundle,canonical,contentHash} from '../lib/workspace-export.ts';
const now='2026-10-18T12:00:00.000Z';
async function setup(){const fixture=database();const seed=createSeedWorkspace(now);seed.tasks[0].status='todo';seed.tasks[1].status='doing';await loadWorkspace(fixture.db,'a',()=>seed,now);await loadWorkspace(fixture.db,'b',()=>createSeedWorkspace(now),now);return fixture;}
let mutation=0;
async function run(db:ReturnType<typeof database>['db'],command:unknown,expectedRevision?:number){return executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:expectedRevision??(await readCurrent(db,'a',now)).revision,mutationId:`planning-fixture-${String(mutation++).padStart(5,'0')}`,command},{db,now:()=>now,handlers:planningHandlers});}
function ruleInput(context:Awaited<ReturnType<typeof readCurrent>>){const task=context.workspace.tasks[0];return {startDate:'2026-01-01',endDate:null,enabled:true,pattern:{frequency:'daily',interval:1},template:{estimateMinutes:30,projectId:task.projectId,milestoneId:task.milestoneId,title:'Review',notes:'',horizon:'next',priority:'normal',blocker:'',sourceUrl:null}};}
async function createRule(db:ReturnType<typeof database>['db']){await run(db,{type:'recurrence.create',rule:ruleInput(await readCurrent(db,'a',now))});return (await ownerReader(db,'a').list('recurrence_rules'))[0];}
test('weekly explicit membership/capacity and carry commit without accepting proposals or rewriting prior weeks',async()=>{
 const {db,sqlite}=await setup();const before=await readCurrent(db,'a',now),id=before.workspace.tasks[0].id,proposal=before.workspace.tasks[2].id;
 await assert.rejects(run(db,{type:'weekly.set',weekStart:'2026-10-12',capacityMinutes:60,taskIds:[proposal]}),/accepted/);assert.equal((await readCurrent(db,'a',now)).revision,1);
 await run(db,{type:'weekly.set',weekStart:'2026-10-12',capacityMinutes:60,taskIds:[id]});await run(db,{type:'weekly.carry',fromWeek:'2026-10-12',toWeek:'2026-10-19',taskIds:[id]});await run(db,{type:'weekly.carry',fromWeek:'2026-10-12',toWeek:'2026-10-19',taskIds:[id]});
 const weeks=await ownerReader(db,'a').list('weekly_plans');assert.equal(weeks.length,2);for(const row of weeks)assert.deepEqual(JSON.parse(row.payload_json).taskIds,[id]);assert.equal((await readCurrent(db,'a',now)).workspace.tasks.find(task=>task.id===id)!.weeklyWeek,'2026-10-12');assert.equal((await readCurrent(db,'a',now)).workspace.tasks.find(task=>task.id===proposal)!.status,'proposed');assert.equal((await ownerReader(db,'b').list('weekly_plans')).length,0);sqlite.close();
});
test('reviews freeze history and corrections append rather than overwriting; archived targets reject new commitments',async()=>{
 const {db,sqlite}=await setup();const before=await readCurrent(db,'a',now),task=before.workspace.tasks[0];await run(db,{type:'weekly.set',weekStart:'2026-10-12',capacityMinutes:null,taskIds:[task.id]});await run(db,{type:'weekly.review',weekStart:'2026-10-12',reflection:'Original',nextWeekNotes:'Next',supersedesId:null});const original=(await ownerReader(db,'a').list('weekly_reviews'))[0];await run(db,{type:'weekly.review',weekStart:'2026-10-12',reflection:'Corrected',nextWeekNotes:'Next',supersedesId:original.id});assert.equal((await ownerReader(db,'a').get('weekly_reviews',original.id))!.payload_json,original.payload_json);assert.equal((await ownerReader(db,'a').list('weekly_reviews')).length,2);
 const current=await readCurrent(db,'a',now);current.workspace.projects[0].archivedAt=now;const context:PrepareContext={userId:'a',before:current,command:{type:'weekly.set',weekStart:'2026-11-02',capacityMinutes:null,taskIds:[task.id]},now,query:ownerReader(db,'a'),async readImport(){throw new Error('unused');}};await assert.rejects(planningHandlers.get('weekly.set')!.prepare(context),/active project/);sqlite.close();
});
test('recurrence rule revisions, stable occurrence ledger and lost-response retry generate only proposed unpinned tasks',async()=>{
 const {db,sqlite}=await setup();const rule=await createRule(db);const input=ruleInput(await readCurrent(db,'a',now));await assert.rejects(run(db,{type:'recurrence.update',id:rule.id,expectedRuleRevision:2,rule:input}),/revision/);const revision=(await readCurrent(db,'a',now)).revision;const mutationId='recurrence-replay-fixture';const command={type:'recurrence.materialize',id:rule.id,from:'2026-01-01',through:'2026-01-03'};const request={protocolVersion:1,expectedRevision:revision,mutationId,command};const deps={db,now:()=>now,handlers:planningHandlers};await executeWorkspaceCommand('a',request,deps);assert.equal((await executeWorkspaceCommand('a',request,deps)).status,'replayed');await run(db,command);
 const occurrences=await ownerReader(db,'a').list('recurrence_occurrences');assert.equal(occurrences.length,3);for(const row of occurrences){const occurrence=JSON.parse(row.payload_json);const task=(await readCurrent(db,'a',now)).workspace.tasks.find(task=>task.id===occurrence.taskId)!;assert.equal(task.status,'proposed');assert.equal(task.weekly,false);assert.deepEqual(task.dependsOn,[]);assert.equal(task.evidence,'');}await assert.rejects(executeWorkspaceCommand('b',{...request,expectedRevision:1,mutationId:'foreign-rule-fixture'},{...deps}),/missing for this owner/);sqlite.close();
});
test('removed occurrence tombstone prevents resurrection and materialization is bounded to fifty',async()=>{
 const {db,sqlite}=await setup();const rule=await createRule(db),date='2026-01-01',id=recurrenceOccurrenceId(rule.id,date);const value={ruleId:rule.id,occurrenceDate:date,taskId:`repeat:${rule.id}:${date}`,generatedAt:now,disposition:'removed'};sqlite.prepare('INSERT INTO recurrence_occurrences(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('a',id,JSON.stringify(value),await contentHash(canonical(value)));const before=(await readCurrent(db,'a',now)).workspace.tasks.length;
 const revision=(await readCurrent(db,'a',now)).revision,receipts=sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_mutations').get()!.n;await assert.rejects(run(db,{type:'recurrence.materialize',id:rule.id,from:date,through:'2026-03-31'}),/at most 50 new/);assert.equal((await readCurrent(db,'a',now)).revision,revision);assert.equal((await readCurrent(db,'a',now)).workspace.tasks.length,before);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_mutations').get()!.n,receipts);await run(db,{type:'recurrence.materialize',id:rule.id,from:date,through:'2026-02-20'});assert.equal((await readCurrent(db,'a',now)).workspace.tasks.length,before+50);assert.equal((await ownerReader(db,'a').get('recurrence_occurrences',id))!.payload_json,JSON.stringify(value));assert.equal((await readCurrent(db,'a',now)).workspace.tasks.some(task=>task.id===value.taskId),false);sqlite.close();
});
test('planning adapters have no registration side effect and validate row keys/history/occurrence references',async()=>{
 const {db,sqlite}=await setup();const registry=new ExportRegistry();registry.register(exportRegistry.get('audit_events'));for(const adapter of planningExportAdapters)registry.register(adapter);assert.equal(planningReferenceDescriptors.length,4);const rule=await createRule(db);await run(db,{type:'recurrence.materialize',id:rule.id,from:'2026-01-01',through:'2026-01-01'});const bundle=await exportWorkspaceBundle(db,'a',{registry});assert.deepEqual(parseWorkspaceBundle(bundle,registry).modules,bundle.modules);
 const wrongKey=structuredClone(bundle);(wrongKey.modules.recurrence_rules.records[0] as {id:string}).id='wrong';assert.throws(()=>parseWorkspaceBundle(wrongKey,registry),/row key/);
 const missingTask=structuredClone(bundle);missingTask.planning.tasks=missingTask.planning.tasks.filter(task=>!task.id.startsWith('repeat:'));assert.throws(()=>parseWorkspaceBundle(missingTask,registry),/occurrence task/);
 const brokenHistory=structuredClone(bundle);brokenHistory.modules.weekly_reviews.records=[{id:'review',rowRevision:1,contentHash:'a'.repeat(64),value:{id:'review',weekStart:'2026-10-12'}}];assert.throws(()=>parseWorkspaceBundle(brokenHistory,registry));sqlite.close();
});
test('failed capacity materialization is atomic and archived targets produce an actionable error',async()=>{
 const {db,sqlite}=database();const seed=createSeedWorkspace(now);const model=seed.tasks[0];seed.tasks=Array.from({length:2000},(_,index)=>({...model,id:`task-${index}`,notes:'',title:'Task',sourceUrl:null,dependsOn:[],blocker:'',evidence:''}));await loadWorkspace(db,'a',()=>seed,now);const rule=await createRule(db);const revision=(await readCurrent(db,'a',now)).revision;await assert.rejects(run(db,{type:'recurrence.materialize',id:rule.id,from:'2026-01-01',through:'2026-01-01'}));assert.equal((await readCurrent(db,'a',now)).revision,revision);assert.equal((await ownerReader(db,'a').list('recurrence_occurrences')).length,0);
 const before=await readCurrent(db,'a',now);before.workspace.milestones[0].archivedAt=now;const context:PrepareContext={userId:'a',before,command:{type:'recurrence.materialize',id:rule.id,from:'2026-01-01',through:'2026-01-01'},now,query:ownerReader(db,'a'),async readImport(){throw new Error('unused');}};await assert.rejects(planningHandlers.get('recurrence.materialize')!.prepare(context),/needs attention/);assert.equal((await ownerReader(db,'a').list('recurrence_occurrences')).length,0);sqlite.close();
});
test('simultaneous generators share workspace CAS and occurrence insertion cannot partially commit',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'control-room-planning-cas-')),path=join(directory,'synthetic.sqlite'),{db,sqlite}=openPlanningCasDatabase(path,true);
 try{
  const seed=createSeedWorkspace(now);seed.tasks[0].status='todo';seed.tasks[1].status='doing';await loadWorkspace(db,'a',()=>seed,now);
  const rule=await createRule(db),revision=(await readCurrent(db,'a',now)).revision,command={type:'recurrence.materialize',id:rule.id,from:'2026-01-01',through:'2026-01-02'};
  const sql=new WeakMap<Parameters<typeof db.batch>[0][number],string>();let raced=false;
  const racing:typeof db={prepare(text){const statement=db.prepare(text);sql.set(statement,text);return statement;},async batch(statements){
   // Read-only snapshot batches are not mutation boundaries. The independent
   // isolate owns its own admission queue and native connection, like another
   // Worker process; it still uses the real public command compiler and CAS.
   if(!raced&&statements.some(statement=>/UPDATE\s+workspaces\s+SET\s+content=/iu.test(sql.get(statement)??''))){
    raced=true;
    await new Promise<void>((resolve,reject)=>{
     const worker=new Worker(new URL('./helpers/planning-cas-worker.mjs',import.meta.url),{execArgv:['--experimental-strip-types'],workerData:{path,revision,command,now,mutationId:'planning-independent-winner-'+crypto.randomUUID()}});let received=false;
     const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Synthetic independent CAS worker exceeded its deadline.'));},15000);
     worker.once('message',(message:{status?:string;error?:string})=>{received=true;clearTimeout(timer);if(message.status==='committed')resolve();else reject(new Error(message.error??'Independent command did not commit.'));});
     worker.once('error',error=>{clearTimeout(timer);reject(error);});
     worker.once('exit',code=>{clearTimeout(timer);if(!received)reject(new Error('Independent CAS worker exited without a result: '+code));});
    });
   }
   return db.batch(statements);
  }};
  const outcome=await run(racing,command,revision);assert.equal(raced,true);assert.equal(outcome.status,'conflict');
  assert.equal((await readCurrent(db,'a',now)).revision,revision+1);
  assert.equal((await ownerReader(db,'a').list('recurrence_occurrences')).length,2);assert.equal((await readCurrent(db,'a',now)).workspace.tasks.filter(task=>task.id.startsWith('repeat:')).length,2);
 }finally{sqlite.close();await rm(directory,{recursive:true,force:true});}
});
test('legacy task pin, unpin and bulk archive synchronize current canonical membership atomically without rewriting old weeks',async()=>{
 const {syncLegacyWeeklyPins}=await import('../lib/planning-module.ts');const {applyCommand}=await import('../lib/planning.ts');const {applyWorkflowCommand}=await import('../lib/planning-workflows.ts');
 const {db,sqlite}=await setup();const ids=(await readCurrent(db,'a',now)).workspace.tasks.slice(0,2).map(task=>task.id);await run(db,{type:'weekly.set',weekStart:'2026-10-05',capacityMinutes:42,taskIds:[ids[0]]});const old=(await ownerReader(db,'a').get('weekly_plans','2026-10-05'))!.payload_json;
 const handlers=new Map(planningHandlers);const prepare:import('../lib/workspace-transaction.ts').CommandHandler['prepare']=async ctx=>{const planningAfter=ctx.command.type==='task.bulk'?applyWorkflowCommand(ctx.before.workspace,ctx.command,{now:ctx.now,newId:()=>crypto.randomUUID()}).workspace:applyCommand(ctx.before.workspace,ctx.command,ctx.now);return {planningAfter,writes:await syncLegacyWeeklyPins(ctx,planningAfter),jobs:[],events:[{id:crypto.randomUUID(),kind:ctx.command.type,entityType:'task',entityId:null,changes:[],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:null,undoOf:null}]};};for(const type of ['task.update','task.bulk'])handlers.set(type,{prepare});
 const send=async(command:unknown)=>executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:(await readCurrent(db,'a',now)).revision,mutationId:`weekly-sync-fixture-${mutation++}`,command},{db,now:()=>now,handlers});
 await send({type:'task.update',id:ids[0],patch:{weekly:true}});await run(db,{type:'weekly.set',weekStart:'2026-10-12',capacityMinutes:90,taskIds:ids});const before=(await ownerReader(db,'a').get('weekly_plans','2026-10-12'))!;
 await send({type:'task.update',id:ids[0],patch:{weekly:false}});const unpinned=JSON.parse((await ownerReader(db,'a').get('weekly_plans','2026-10-12'))!.payload_json);assert.deepEqual(unpinned.taskIds,[ids[1]]);assert.equal(unpinned.capacityMinutes,90);
 await send({type:'task.bulk',ids:[ids[1]],patch:{status:'archived'}});assert.deepEqual(JSON.parse((await ownerReader(db,'a').get('weekly_plans','2026-10-12'))!.payload_json).taskIds,[]);assert.equal((await readCurrent(db,'a',now)).workspace.tasks.find(task=>task.id===ids[1])!.status,'archived');assert.equal((await ownerReader(db,'a').get('weekly_plans','2026-10-05'))!.payload_json,old);assert.ok((await ownerReader(db,'a').get('weekly_plans','2026-10-12'))!.row_revision>before.row_revision);sqlite.close();
});
test('legacy synchronization initializes from prior pins, preserves unrelated canonical members and skips unchanged pins',async()=>{
 const {syncLegacyWeeklyPins}=await import('../lib/planning-module.ts');const {db,sqlite}=await setup();const before=await readCurrent(db,'a',now);before.workspace.tasks[0].weekly=true;before.workspace.tasks[0].weeklyWeek='2026-10-12';const after=structuredClone(before.workspace);after.tasks[1].weekly=true;after.tasks[1].weeklyWeek='2026-10-12';const ctx:PrepareContext={userId:'a',before,command:{type:'task.update'},now,query:ownerReader(db,'a'),async readImport(){throw new Error('unused');}};const writes=await syncLegacyWeeklyPins(ctx,after);assert.equal(writes[0].operation,'insert');assert.deepEqual((writes[0].value as {taskIds:string[]}).taskIds,[after.tasks[0].id,after.tasks[1].id]);assert.equal(writes[0].expectedRowRevision,null);
 const unchanged=await syncLegacyWeeklyPins({...ctx,query:{async get(){throw new Error('No module read expected');},async list(){return [];}}},before.workspace);assert.deepEqual(unchanged,[]);
 const value={weekStart:'2026-10-12',capacityMinutes:77,taskIds:[before.workspace.tasks[3].id],revision:3};sqlite.prepare('INSERT INTO weekly_plans(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,3,?,?)').run('a',value.weekStart,JSON.stringify(value),await contentHash(canonical(value)));const updates=await syncLegacyWeeklyPins(ctx,after);assert.equal(updates[0].expectedRowRevision,3);assert.deepEqual((updates[0].value as {taskIds:string[]}).taskIds,[before.workspace.tasks[3].id,after.tasks[1].id]);assert.equal((updates[0].value as {capacityMinutes:number}).capacityMinutes,77);sqlite.close();
});

test('future commitments preserve today pins and canonical rollover hydrates current membership without changing history or storage',async()=>{
 const {db,sqlite}=await setup();const original=await readCurrent(db,'a',now),id=original.workspace.tasks[0].id;await run(db,{type:'weekly.set',weekStart:'2026-10-12',capacityMinutes:90,taskIds:[id]});const old=(await ownerReader(db,'a').get('weekly_plans','2026-10-12'))!;
 await run(db,{type:'weekly.carry',fromWeek:'2026-10-12',toWeek:'2026-10-19',taskIds:[id]});const today=await readCurrent(db,'a',now);assert.equal(today.workspace.tasks.find(task=>task.id===id)!.weeklyWeek,'2026-10-12');assert.equal(today.workspace.tasks.find(task=>task.id===id)!.weekly,true);
 const persisted=sqlite.prepare('SELECT content,revision,updated_at FROM workspaces WHERE user_id=?').get('a');const next=await readCurrent(db,'a','2026-10-19T00:00:00.000Z');assert.equal(next.workspace.tasks.find(task=>task.id===id)!.weeklyWeek,'2026-10-19');assert.equal(next.workspace.tasks.find(task=>task.id===id)!.weekly,true);assert.equal(next.revision,today.revision);assert.deepEqual(sqlite.prepare('SELECT content,revision,updated_at FROM workspaces WHERE user_id=?').get('a'),persisted);assert.equal((await ownerReader(db,'a').get('weekly_plans','2026-10-12'))!.payload_json,old.payload_json);
});

test('future weekly set cannot pin an uncommitted task today, and current hydration retains noncurrent legacy metadata',async()=>{
 const {db}=await setup();const {hydrateCurrentWeeklyPins}=await import('../lib/weekly-planning.ts');const original=await readCurrent(db,'a',now),id=original.workspace.tasks[0].id;await run(db,{type:'weekly.set',weekStart:'2026-10-19',capacityMinutes:null,taskIds:[id]});assert.equal((await readCurrent(db,'a',now)).workspace.tasks.find(task=>task.id===id)!.weekly,false);assert.equal((await readCurrent(db,'a','2026-10-19T00:00:00.000Z')).workspace.tasks.find(task=>task.id===id)!.weekly,true);
 const legacy=structuredClone(original.workspace);legacy.tasks[0].weekly=true;legacy.tasks[0].weeklyWeek='2026-10-05';legacy.tasks[1].weekly=true;legacy.tasks[1].weeklyWeek='2026-10-12';const hydrated=hydrateCurrentWeeklyPins(legacy,{weekStart:'2026-10-12',capacityMinutes:null,taskIds:[],revision:1},now);assert.equal(hydrated.tasks[0].weeklyWeek,'2026-10-05');assert.equal(hydrated.tasks[0].weekly,true);assert.equal(hydrated.tasks[1].weekly,false);assert.equal(hydrated.tasks[1].weeklyWeek,null);assert.equal(legacy.tasks[1].weekly,true);
});
