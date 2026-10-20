import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {applyProjectBaseline,baselineRecordId,getProjectBaseline} from '../lib/project-baselines.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand,type CommandHandler} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {previewEntityDeletion} from '../lib/workspace-deletion.ts';
const at='2026-10-18T12:00:00.000Z';
async function fixture(){
 const {db,sqlite}=database();const seed=createSeedWorkspace(at);const project=seed.projects[0];const baseline=getProjectBaseline(project)!;assert.ok(baseline);const taskId=baselineRecordId(project.id,baseline.actions[0].key),captureId=baselineRecordId(project.id,'context');const workspace=applyProjectBaseline(seed,project.id,'2026-10-17',at);const task=workspace.tasks.find(row=>row.id===taskId)!;task.status='archived';task.archivedFromStatus='proposed';workspace.captures.find(row=>row.id===captureId)!.status='archived';
 for(const owner of ['synthetic-a','synthetic-b'])await loadWorkspace(db,owner,()=>structuredClone(workspace),at);
 return {db,sqlite,workspace,project,taskId,captureId};
}
async function remove(db:SqlDatabase,owner:string,kind:'task'|'capture',id:string){const before=await readCurrent(db,owner);const preview=await previewEntityDeletion(before.workspace,kind,id,before.revision);assert.equal(preview.canDelete,true);return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:before.revision,mutationId:crypto.randomUUID(),command:{type:'entity.delete',entityType:kind,id,previewHash:preview.previewHash,targetRevision:before.revision}},{db,now:()=>at,handlers:workspaceHandlers});}

test('readCurrent projects actual owner deletion audits into deterministic baseline task/context tombstones',async()=>{
 const {db,sqlite,project,taskId,captureId}=await fixture();try{
  assert.equal((await readCurrent(db,'synthetic-a')).baselineRemovedIds,undefined);
  assert.equal((await remove(db,'synthetic-a','task',taskId)).status,'committed');assert.equal((await remove(db,'synthetic-a','capture',captureId)).status,'committed');const current=await readCurrent(db,'synthetic-a');assert.deepEqual(current.baselineRemovedIds,[taskId,captureId].sort());assert.equal(current.workspace.tasks.some(row=>row.id===taskId),false);assert.equal(current.workspace.captures.some(row=>row.id===captureId),false);
  const events=sqlite.prepare("SELECT kind,entity_type,entity_id FROM audit_events WHERE user_id=? AND kind='entity.delete' ORDER BY entity_id").all('synthetic-a');assert.equal(events.length,2);assert.deepEqual(events.map(row=>row.entity_type).sort(),['capture','task']);const beforeAuditCount=sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n;const readAgain=await readCurrent(db,'synthetic-a');assert.equal(readAgain.revision,current.revision);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n,beforeAuditCount);
  const reapplied=applyProjectBaseline(current.workspace,project.id,'2026-10-17',at,current.baselineRemovedIds);assert.equal(reapplied.tasks.some(row=>row.id===taskId),false);assert.equal(reapplied.captures.some(row=>row.id===captureId),false);assert.equal((await readCurrent(db,'synthetic-b')).baselineRemovedIds,undefined);
 }finally{sqlite.close();}
});

test('another owner and imported historical deletion claims cannot manufacture baseline suppression',async()=>{
 const {db,sqlite,taskId,captureId}=await fixture();try{
  await remove(db,'synthetic-b','task',taskId);assert.deepEqual((await readCurrent(db,'synthetic-b')).baselineRemovedIds,[taskId]);assert.equal((await readCurrent(db,'synthetic-a')).baselineRemovedIds,undefined);
  const handler:CommandHandler={async prepare(context){return {planningAfter:context.before.workspace,writes:[],events:[],jobs:[],historyImports:[taskId,captureId].map((id,index)=>({id:`synthetic-imported-claim-${index}`,importHash:'a'.repeat(64),source:{kind:'entity.delete',entityType:index?'capture':'task',entityId:id,actorId:'synthetic-a',origin:'owner',occurredAt:at,changes:[]}}))};}};
  const before=await readCurrent(db,'synthetic-a');assert.equal((await executeWorkspaceCommand('synthetic-a',{protocolVersion:1,expectedRevision:before.revision,mutationId:crypto.randomUUID(),command:{type:'synthetic.import-claims'}},{db,now:()=>at,handlers:new Map([['synthetic.import-claims',handler]])})).status,'committed');const stored=sqlite.prepare('SELECT kind,entity_type,entity_id,payload_json FROM audit_events WHERE user_id=?').all('synthetic-a');assert.equal(stored.length,2);for(const row of stored){assert.equal(row.kind,'imported-history');assert.equal(row.entity_type,'historical-claim');assert.equal(row.entity_id,null);assert.match(String(row.payload_json),/entity.delete/);}const after=await readCurrent(db,'synthetic-a');assert.equal(after.baselineRemovedIds,undefined);assert.equal(after.workspace.tasks.some(row=>row.id===taskId),true);assert.equal(after.workspace.captures.some(row=>row.id===captureId),true);
 }finally{sqlite.close();}
});

test('unrelated event kinds, entity types and noncandidate IDs are ignored; projection is distinct and ordered',async()=>{
 const {db,sqlite,project,taskId,captureId}=await fixture();try{
  const insert=sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,NULL,NULL,?,?,?,?,?,?,?)');let sequence=0;
  const audit=(kind:string,type:string,id:string)=>insert.run('synthetic-a',`synthetic-audit-${sequence}`,'synthetic-stream',sequence++,kind,type,id,at,JSON.stringify({kind:'entity.delete',entityType:'task',entityId:taskId,origin:'owner',actorId:'synthetic-a'}));
  audit('task.update','task',taskId);audit('imported-history','task',captureId);audit('entity.delete','project',taskId);audit('entity.delete','milestone',captureId);audit('entity.delete','task','ordinary-nonbaseline-task');audit('entity.delete','capture',baselineRecordId(project.id,'unknown-action'));audit('entity.delete','task',baselineRecordId('different-project','unknown-action'));
  assert.equal((await readCurrent(db,'synthetic-a')).baselineRemovedIds,undefined);
  audit('entity.delete','capture',captureId);audit('entity.delete','task',taskId);audit('entity.delete','task',taskId);assert.deepEqual((await readCurrent(db,'synthetic-a')).baselineRemovedIds,[taskId,captureId].sort());assert.equal((await readCurrent(db,'synthetic-b')).baselineRemovedIds,undefined);
 }finally{sqlite.close();}
});
