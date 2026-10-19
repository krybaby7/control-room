import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {previewHistoryUndo} from '../lib/history-undo-store.ts';
import {readAuditCommandGroup} from '../lib/history-command-group.ts';
import {previewEntityDeletion} from '../lib/workspace-deletion.ts';
import {readReferenceSnapshot,referenceRegistry} from '../lib/workspace-references.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import type {AuditEventDraft} from '../lib/audit-events.ts';
const initial='2026-10-18T09:00:00.000Z',createdAt='2026-10-18T10:00:00.000Z',now='2026-10-18T12:00:00.000Z',later='2026-10-18T13:00:00.000Z';
async function setup(){const result=database();for(const owner of ['a','b'])await loadWorkspace(result.db,owner,()=>createSeedWorkspace(initial),initial);return result;}
async function send(db:SqlDatabase,command:unknown,clock=now,mutationId=crypto.randomUUID(),revision?:number){return executeWorkspaceCommand('a',{protocolVersion:1,mutationId,expectedRevision:revision??(await readCurrent(db,'a')).revision,command},{db,handlers:workspaceHandlers,now:()=>clock});}
function undo(preview:Awaited<ReturnType<typeof previewHistoryUndo>>){return {type:'history.undo',eventId:preview.eventId,sourceMutationId:preview.sourceMutationId,previewHash:preview.previewHash,targetRevision:preview.targetRevision};}
async function createTask(db:SqlDatabase){const current=await readCurrent(db,'a');const title=`Synthetic presence ${crypto.randomUUID()}`;await send(db,{type:'task.create',task:{estimateMinutes:null,projectId:current.workspace.projects[0].id,milestoneId:null,title,notes:'',status:'todo',horizon:'now',priority:'normal',dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:''}},createdAt);return (await readCurrent(db,'a')).workspace.tasks.find(row=>row.title===title)!;}
function source(sqlite:ReturnType<typeof database>['sqlite'],kind:string):AuditEventDraft{const row=sqlite.prepare('SELECT payload_json FROM audit_events WHERE user_id=? AND kind=? ORDER BY workspace_revision DESC,ordinal DESC LIMIT 1').get('a',kind);assert.ok(row);return JSON.parse(row.payload_json as string);}
async function preview(db:SqlDatabase,eventId:string,clock=now){return previewHistoryUndo(db,'a',eventId,(await readCurrent(db,'a')).revision,clock);}
test('SQLite public create undo receipts replay once; undo-of-undo restores exact identity and timestamps',async()=>{
 const {db,sqlite}=await setup();try{
  const task=await createTask(db),event=source(sqlite,'task.create'),original=await readAuditCommandGroup(db,'a',event.id);assert.ok(original);const selected=await preview(db,event.id);assert.equal(selected.changes.length,1);assert.equal(selected.changes[0].after.exists,false);
  const mutationId=crypto.randomUUID();await send(db,undo(selected),now,mutationId);assert.equal((await readCurrent(db,'a')).workspace.tasks.some(row=>row.id===task.id),false);
  assert.equal((await send(db,undo(selected),later,mutationId,selected.targetRevision)).status,'replayed');assert.equal((await readCurrent(db,'a')).revision,selected.targetRevision+1);
  const inverse=source(sqlite,'history.undo');assert.equal(inverse.undoOf,event.id);await send(db,undo(await preview(db,inverse.id,later)),later);
  assert.deepEqual((await readCurrent(db,'a')).workspace.tasks.find(row=>row.id===task.id),task);assert.equal(task.createdAt,createdAt);assert.equal(task.updatedAt,createdAt);assert.deepEqual(await readAuditCommandGroup(db,'a',event.id),original);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE user_id='a' AND kind='history.undo'").get()!.n,2);
  await assert.rejects(previewHistoryUndo(db,'b',event.id,1,now),/unavailable/);
 }finally{sqlite.close();}
});
test('SQLite archived task deletion keeps a complete backup and undo restores its full tombstone',async()=>{
 const {db,sqlite}=await setup();try{
  const task=await createTask(db);await send(db,{type:'task.update',id:task.id,patch:{status:'archived'}});const before=await readCurrent(db,'a'),tombstone=before.workspace.tasks.find(row=>row.id===task.id)!;
  const snapshot=await readReferenceSnapshot(ownerReader(db,'a'),referenceRegistry),deletion=await previewEntityDeletion(before.workspace,'task',task.id,before.revision,snapshot);assert.equal(deletion.canDelete,true);
  await send(db,{type:'entity.delete',entityType:'task',id:task.id,targetRevision:before.revision,previewHash:deletion.previewHash});assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_backups WHERE user_id='a' AND status='ready'").get()!.n,1);
  const event=source(sqlite,'entity.delete');assert.deepEqual(event.changes[0].before.value,tombstone);assert.equal(event.changes[0].after.exists,false);
  await send(db,undo(await preview(db,event.id)),later);assert.deepEqual((await readCurrent(db,'a')).workspace.tasks.find(row=>row.id===task.id),tombstone);
  await assert.rejects(preview(db,event.id,later),/already in use/);
 }finally{sqlite.close();}
});
test('new normalized weekly reference blocks creation removal even when the original task remains unchanged',async()=>{
 const {db,sqlite}=await setup();try{
  const task=await createTask(db),event=source(sqlite,'task.create');await send(db,{type:'weekly.set',weekStart:'2026-10-05',taskIds:[task.id],capacityMinutes:120});assert.deepEqual((await readCurrent(db,'a')).workspace.tasks.find(row=>row.id===task.id),task);
  const before=await readCurrent(db,'a'),auditCount=sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n;
  await assert.rejects(preview(db,event.id),/normalized references/);assert.deepEqual(await readCurrent(db,'a'),before);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n,auditCount);assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM weekly_plans WHERE user_id='a'").get()!.n,1);
 }finally{sqlite.close();}
});
test('changed created record and stale presence preview reject atomically without retiring history or IDs',async()=>{
 const {db,sqlite}=await setup();try{
  const task=await createTask(db),event=source(sqlite,'task.create'),selected=await preview(db,event.id);
  await send(db,{type:'task.update',id:task.id,patch:{title:'Later owner edit'}},later);const before=await readCurrent(db,'a'),auditCount=sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n;
  await assert.rejects(send(db,undo(selected),later),/stale/);await assert.rejects(preview(db,event.id,later),/whole record changed/);
  assert.deepEqual(await readCurrent(db,'a'),before);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n,auditCount);assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind='history.undo'").get()!.n,0);assert.ok(await readAuditCommandGroup(db,'a',event.id));
 }finally{sqlite.close();}
});
