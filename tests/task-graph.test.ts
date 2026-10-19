import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import type {Task} from '../lib/types.ts';
import {validateTaskGraph,traverseTaskGraph,getTaskGraphBlockers,taskGraphFulfilled,TaskGraphError} from '../lib/task-graph.ts';
const at='2026-10-18T12:00:00.000Z';
function fixture(){const workspace=createSeedWorkspace(at);const first=workspace.projects[0].id,second=workspace.projects[1].id;workspace.projects[0].name='Project Alpha';workspace.projects[1].name='Project Beta';const base={...workspace.tasks[0],milestoneId:null,status:'todo' as const,dependsOn:[],blocker:'',completedAt:null,archivedFromStatus:null};const task=(id:string,projectId=first,patch:Partial<Task>={}):Task=>({...base,id,title:`Task ${id}`,projectId,...patch});workspace.tasks=[task('a'),task('b',second,{dependsOn:['a']})];workspace.captures=[];return {workspace,task,first,second};}
function graphError(code:string){return (error:unknown)=>error instanceof TaskGraphError&&error.code===code;}

test('cross-project prerequisites are legal and blockers contain linked prerequisite IDs and project labels',()=>{
 const {workspace}=fixture();const before=structuredClone(workspace);validateTaskGraph(workspace);const [blocker]=getTaskGraphBlockers(workspace,'b');assert.equal(blocker.prerequisiteId,'a');assert.equal(blocker.projectLabel,'Project Alpha');assert.equal(blocker.kind,'unfinished');assert.deepEqual(workspace,before);
});

test('missing/foreign-scope prerequisite fails without looking up any external owner',()=>{
 const {workspace}=fixture();workspace.tasks[1].dependsOn=['foreign-private-id'];assert.throws(()=>validateTaskGraph(workspace),graphError('missing-dependency'));assert.throws(()=>getTaskGraphBlockers(workspace,'missing'),TaskGraphError);
});

for(const invalid of ['duplicate-dependency','self-dependency','cycle','invalid-dependencies','duplicate-task','missing-project'] as const)test(`graph validation rejects ${invalid}`,()=>{
 const {workspace,task}=fixture();if(invalid==='duplicate-dependency')workspace.tasks[1].dependsOn=['a','a'];else if(invalid==='self-dependency')workspace.tasks[0].dependsOn=['a'];else if(invalid==='cycle')workspace.tasks[0].dependsOn=['b'];else if(invalid==='invalid-dependencies'){workspace.tasks=[task('root'),...Array.from({length:51},(_,i)=>task(`p-${i}`))];workspace.tasks[0].dependsOn=workspace.tasks.slice(1).map(row=>row.id);}else if(invalid==='duplicate-task')workspace.tasks.push({...workspace.tasks[0]});else workspace.tasks[0].projectId='unavailable';assert.throws(()=>validateTaskGraph(workspace),graphError(invalid));
});

test('completion validates final whole graph across projects and rejects incomplete archived prerequisites',()=>{
 const {workspace}=fixture();workspace.tasks[1].status='done';workspace.tasks[1].completedAt=at;assert.throws(()=>validateTaskGraph(workspace),error=>{assert.ok(error instanceof TaskGraphError);assert.equal(error.code,'completed-blocked');assert.equal(error.issues[0].blockers?.[0].prerequisiteId,'a');return true;});
 workspace.tasks[0].status='archived';workspace.tasks[0].archivedFromStatus='todo';assert.throws(()=>validateTaskGraph(workspace),graphError('completed-blocked'));workspace.tasks[0].archivedFromStatus='done';workspace.tasks[0].completedAt=at;validateTaskGraph(workspace);assert.deepEqual(getTaskGraphBlockers(workspace,'b'),[]);assert.equal(taskGraphFulfilled(workspace.tasks[0]),true);
});

test('archived unfinished and absent archive metadata stay blockers despite completion timestamps or project metadata',()=>{
 const {workspace}=fixture();workspace.tasks[0].status='archived';workspace.tasks[0].completedAt=at;delete workspace.tasks[0].archivedFromStatus;Object.assign(workspace.projects[0],{archived:true});assert.equal(taskGraphFulfilled(workspace.tasks[0]),false);const [blocked]=getTaskGraphBlockers(workspace,'b');assert.equal(blocked.kind,'archived-unfinished');assert.match(blocked.message,/restored and completed/);
});

test('archived completed dependent retains completion guards and explicit blockers prevent completion',()=>{
 const {workspace}=fixture();workspace.tasks[0].status='done';workspace.tasks[0].completedAt=at;workspace.tasks[1].status='archived';workspace.tasks[1].archivedFromStatus='done';workspace.tasks[1].completedAt=at;validateTaskGraph(workspace);workspace.tasks[1].blocker='Owner acceptance missing';assert.throws(()=>validateTaskGraph(workspace),error=>{assert.ok(error instanceof TaskGraphError);assert.equal(error.issues[0].blockers?.[0].kind,'manual');assert.equal(error.issues[0].blockers?.[0].message,'Owner acceptance missing');return true;});
});

test('traversal follows transitive prerequisites and dependents with labels and accessible blocker rows',()=>{
 const {workspace,task,first,second}=fixture();workspace.tasks=[task('p',first),task('root',second,{dependsOn:['p']}),task('child',first,{dependsOn:['root']}),task('grandchild',second,{dependsOn:['child']}),task('sibling',first,{dependsOn:['p']})];const graph=traverseTaskGraph(workspace,'root');assert.deepEqual(graph.visible.map(row=>row.id),['root','p','child','grandchild']);assert.deepEqual(graph.visible.map(row=>row.relation),['root','prerequisite','dependent','dependent']);assert.equal(graph.visible[0].projectLabel,'Project Beta');assert.equal(graph.rootBlockers[0].prerequisiteId,'p');assert.equal(graph.remainingCount,0);assert.equal(graph.visible[0].blockers[0].projectLabel,'Project Alpha');assert.ok(!graph.visible.some(row=>row.id==='sibling'));
});

test('large valid graph caps visualization at 200 and places every remaining task and blocker in explicit table',()=>{
 const {workspace,task}=fixture();workspace.tasks=Array.from({length:325},(_,i)=>task(`task-${String(i).padStart(3,'0')}`,workspace.projects[i%2].id,{dependsOn:i===0?[]:[`task-${String(i-1).padStart(3,'0')}`]}));const before=structuredClone(workspace);const graph=traverseTaskGraph(workspace,'task-324');assert.equal(graph.totalNodes,325);assert.equal(graph.visible.length,200);assert.equal(graph.remainingCount,125);assert.equal(graph.remainingTable.length,125);assert.equal(new Set([...graph.visible,...graph.remainingTable].map(row=>row.id)).size,325);assert.equal(graph.remainingTable[0].blockers[0].prerequisiteId,'task-123');assert.equal(graph.remainingTable.at(-1)?.id,'task-000');assert.ok(graph.edges.every(edge=>graph.visible.some(row=>row.id===edge.taskId)&&graph.visible.some(row=>row.id===edge.prerequisiteId)));assert.deepEqual(workspace,before);
});

test('a 50-prerequisite root keeps all 50 blockers even with a one-node graph display',()=>{
 const {workspace,task}=fixture();workspace.tasks=[task('root',workspace.projects[0].id,{dependsOn:Array.from({length:50},(_,i)=>`p-${i}`)}),...Array.from({length:50},(_,i)=>task(`p-${i}`,workspace.projects[1].id))];const graph=traverseTaskGraph(workspace,'root',{maxVisible:1});assert.equal(graph.visible.length,1);assert.equal(graph.rootBlockers.length,50);assert.equal(graph.remainingCount,50);assert.ok(graph.rootBlockers.every(blocker=>blocker.projectLabel==='Project Beta'));
});

test('graph order is deterministic across input order, limits are explicit, and unavailable roots use neutral errors',()=>{
 const {workspace}=fixture();const graph=traverseTaskGraph(workspace,'b');workspace.tasks.reverse();assert.deepEqual(traverseTaskGraph(workspace,'b'),graph);for(const maxVisible of [0,201,1.5])assert.throws(()=>traverseTaskGraph(workspace,'b',{maxVisible}),graphError('invalid-limit'));assert.throws(()=>traverseTaskGraph(workspace,'outside'),error=>error instanceof TaskGraphError&&error.message==='Task is missing or unavailable.');
});

test('iterative validation handles deep graphs and reports an actual cycle path',()=>{
 const {workspace,task}=fixture();workspace.tasks=Array.from({length:4000},(_,i)=>task(`d-${i}`,workspace.projects[0].id,{dependsOn:i<3999?[`d-${i+1}`]:[]}));validateTaskGraph(workspace);workspace.tasks[3999].dependsOn=['d-3997'];assert.throws(()=>validateTaskGraph(workspace),error=>{assert.ok(error instanceof TaskGraphError);assert.equal(error.code,'cycle');assert.deepEqual(error.issues[0].cycle,['d-3997','d-3998','d-3999','d-3997']);return true;});
});
