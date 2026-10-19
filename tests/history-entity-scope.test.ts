import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,taskFixture,milestoneFixture,milestoneInputFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readHistoryPage,type HistoryCursorSecurity} from '../lib/history.ts';
import {canonical} from '../lib/canonical-json.ts';
import type {AuditEventDraft} from '../lib/workspace-protocol.ts';
const owner='synthetic-history-owner',foreign='synthetic-history-foreign',now='2026-10-18T12:00:00.000Z';
const security:HistoryCursorSecurity={secret:new Uint8Array(32).fill(29),now:()=>now};
async function fixture(){const f=database();for(const id of [owner,foreign])await loadWorkspace(f.db,id,()=>workspaceFixture({tasks:[taskFixture('first'),taskFixture('second')]}),now);return f;}
function historical(id:string,entityId='historical-original',patch:Partial<AuditEventDraft>={}):AuditEventDraft{
 const after=milestoneFixture({id:entityId,title:'Retained milestone'});
 return {id,kind:'milestone.create',entityType:'milestone',entityId:null,changes:[{path:['milestones',entityId],before:{exists:false,value:null},after:{exists:true,value:after as unknown as import('../lib/workspace-protocol.ts').JsonValue}}],origin:'owner',actorId:owner,occurredAt:now,sourceRef:null,undoOf:null,...patch};
}
function insert(f:ReturnType<typeof database>,user:string,event:AuditEventDraft,ordinal:number){
 f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,origin,actor_id,source_ref,undo_of,payload_json) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)').run(user,event.id,ordinal,event.kind,event.entityType,event.entityId,event.occurredAt,event.origin,event.actorId,event.sourceRef,event.undoOf,canonical(event));
}
test('actual create records its generated ID and actual bulk remains discoverable for each exact changed task',async()=>{
 const f=await fixture();try{
 const created=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'milestone.create',milestone:milestoneInputFixture()}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.ok(created.status!=='conflict');
 const id=created.envelope.workspace.milestones[0].id,page=await readHistoryPage(f.db,owner,{filters:{entityType:'milestone',entityId:id}},security);
 assert.equal(page.entries.length,1);assert.equal(page.entries[0].entityId,id);assert.equal(page.entries[0].event!.entityId,id);assert.equal(page.entries[0].derivedEntityId,undefined);
 const bulk=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:2,mutationId:crypto.randomUUID(),command:{type:'task.bulk',ids:['first','second'],patch:{priority:'high'}}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.ok(bulk.status!=='conflict');
 const original=f.sqlite.prepare("SELECT payload_json FROM audit_events WHERE user_id=? AND kind='task.bulk'").get(owner)!.payload_json;
 for(const taskId of ['first','second']){
  const selected=await readHistoryPage(f.db,owner,{filters:{entityType:'task',entityId:taskId}},security);
  assert.equal(selected.entries.length,1);assert.equal(selected.entries[0].kind,'task.bulk');assert.equal(selected.entries[0].entityId,null);assert.equal(selected.entries[0].event!.entityId,null);assert.equal(selected.entries[0].derivedEntityId,taskId);
 }
 assert.equal(f.sqlite.prepare("SELECT payload_json FROM audit_events WHERE user_id=? AND kind='task.bulk'").get(owner)!.payload_json,original);
 assert.equal((await readHistoryPage(f.db,foreign,{filters:{entityType:'task',entityId:'first'}},security)).entries.length,0);
 }finally{f.sqlite.close();}
});
test('historical NULL identities retain immutable provenance across exact owner-scoped pagination',async()=>{
 const f=await fixture();try{
 for(let index=0;index<55;index++)insert(f,owner,historical('retained-'+String(index).padStart(3,'0')),index);
 insert(f,foreign,historical('foreign','historical-original',{actorId:foreign}),0);
 const source=f.sqlite.prepare('SELECT * FROM audit_events ORDER BY user_id,event_id').all();
 const entries=[];let cursor:string|null=null;
 do{const page=await readHistoryPage(f.db,owner,{filters:{entityType:'milestone',entityId:'historical-original'},...(cursor?{cursor}:{})},security);entries.push(...page.entries);cursor=page.nextCursor;}while(cursor);
 assert.equal(entries.length,55);assert.equal(new Set(entries.map(entry=>entry.id)).size,55);
 assert.ok(entries.every(entry=>entry.entityId===null&&entry.event!.entityId===null&&entry.derivedEntityId==='historical-original'));
 assert.equal((await readHistoryPage(f.db,owner,{filters:{entityType:'task',entityId:'historical-original'}},security)).entries.length,0);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM audit_events ORDER BY user_id,event_id').all(),source);
 }finally{f.sqlite.close();}
});
test('unknown kinds, legacy summaries, ambiguous duplicate paths and nonexact IDs cannot broaden a scoped history query',async()=>{
 const f=await fixture();try{
 const ordinary=historical('ordinary'),change=ordinary.changes[0];
 for(const [index,event]of [
 historical('unknown','historical-original',{kind:'imported-history'}),
 historical('wrong-type','historical-original',{entityType:'task'}),
 historical('ambiguous','historical-original',{changes:[change,change]}),
 historical('field-path','historical-original',{changes:[{...change,path:['milestones','historical-original','title']}]}),
 historical('literal-wildcard','historical-*')
 ].entries())insert(f,owner,event,index);
 f.sqlite.prepare("INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,'legacy',1,9,'milestone.create','milestone',NULL,?,?)").run(owner,now,canonical({text:'Original legacy summary',origin:'owner',changes:['raw source value',7]}));
 assert.equal((await readHistoryPage(f.db,owner,{filters:{entityType:'milestone',entityId:'historical-original'}},security)).entries.length,0);
 assert.equal((await readHistoryPage(f.db,owner,{filters:{entityId:'historical-original'}},security)).entries.length,0,'no inferred collection without exact entity type');
 }finally{f.sqlite.close();}
});
test('a malformed matching typed claim fails closed without rewriting its original NULL metadata or payload',async()=>{
 const f=await fixture();try{
 const event=historical('malformed'),change=event.changes[0];event.changes=[{...change,after:{exists:true,value:{id:'different'}}}];insert(f,owner,event,0);
 const original=f.sqlite.prepare("SELECT * FROM audit_events WHERE event_id='malformed'").get();
 await assert.rejects(readHistoryPage(f.db,owner,{filters:{entityType:'milestone',entityId:'historical-original'}},security),/Derived history attribution/);
 assert.deepEqual(f.sqlite.prepare("SELECT * FROM audit_events WHERE event_id='malformed'").get(),original);
 }finally{f.sqlite.close();}
});
