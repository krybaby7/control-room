import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerPrepareContext} from '../lib/workspace-context.ts';
import {executeWorkspaceCommand,type MutationPlan} from '../lib/workspace-transaction.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {PRIVATE_PROFILE_TABLES} from '../lib/private-profile.ts';
import {workspacePrivateCapacityGrowth} from '../lib/workspace-private-capacity.ts';
import type {WorkspaceCommand} from '../lib/workspace-protocol.ts';
const now='2026-10-18T12:00:00.000Z',owner='private-capacity-owner';
function usage(sqlite:ReturnType<typeof database>['sqlite']){return new Map(PRIVATE_PROFILE_TABLES.map(table=>{const rows=sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=?').all(owner).map(row=>{const copy={...row};delete copy.user_id;return copy;});return [table,{rows:rows.length,bytes:rows.reduce((n,row)=>n+new TextEncoder().encode(canonical(row)).byteLength+1,0)}];}));}
async function fixture(){const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);return f;}
for(const kind of ['task','agent','budget'] as const)test('actual public '+kind+' command private physical growth fits its server quote',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now),task=before.workspace.tasks.find(row=>row.status!=='archived')!;
  const command:WorkspaceCommand=kind==='budget'?{type:'jobs.budget.configure',id:'synthetic-private-budget',expectedOperationalRevision:null,value:{maximumJobs:2,maximumSeconds:600,enabled:true}}:kind==='agent'?{type:'jobs.create',value:{operation:'project.inspect',projectId:task.projectId,taskId:task.id,repositoryKey:'synthetic-repo',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'synthetic-model',effort:'medium',timeoutSeconds:30,outputBytesLimit:4096,dependsOnJobIds:[]}}:{type:'task.create',task:{projectId:task.projectId,milestoneId:null,title:'Synthetic private capacity task',notes:'Literal Arabic العربية and JSON quote " retained.',status:'todo',horizon:'now',priority:'normal',dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null}};
  const mutationId=crypto.randomUUID(),plan=await workspaceHandlers.get(command.type)!.prepare(ownerPrepareContext(f.db,owner,before,command,now,{},mutationId)),commandHash=await contentHash(canonical({protocolVersion:1,command})),prior=usage(f.sqlite);
  const quote=await workspacePrivateCapacityGrowth(f.db,owner,{plan,before,command,mutationId,commandHash,now,preparedBackup:null});
  for(const guard of quote.guards)assert.ok(await f.db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first());
  const result=await executeWorkspaceCommand(owner,{protocolVersion:1,mutationId,expectedRevision:before.revision,command},{db:f.db,now:()=>now,handlers:new Map([[command.type,{prepare:async()=>plan}]])});assert.equal(result.status,'committed');
  const after=usage(f.sqlite),bounds=new Map(quote.growth.map(row=>[row.table,row]));for(const [table,value]of after){const old=prior.get(table)!;assert.ok(Math.max(0,value.bytes-old.bytes)<=(bounds.get(table)?.bytes??0),table+' bytes must be covered');assert.ok(Math.max(0,value.rows-old.rows)<=(bounds.get(table)?.rows??0),table+' rows must be covered');}
  assert.ok((bounds.get('workspace_mutations')?.bytes??0)<1024,'ordinary receipt quote is concrete, not arbitrary MiB');
 }finally{f.sqlite.close();}
});
test('restore quotes every existing queue row and rejects concurrent owner intent growth without deleting or crediting anything',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now),plan:MutationPlan={planningAfter:before.workspace,writes:[],events:[],jobs:[],restoreEpoch:true,backup:{reason:'restore'}},command={type:'workspace.restore',workspace:before.workspace} as unknown as WorkspaceCommand;
  const prior=f.sqlite.prepare('SELECT total_changes() AS n').get()!.n,quote=await workspacePrivateCapacityGrowth(f.db,owner,{plan,before,command,mutationId:crypto.randomUUID(),commandHash:'a'.repeat(64),now,preparedBackup:null});assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get()!.n,prior);
  const queueGuard=quote.guards.find(guard=>guard.sql.includes('COUNT(*) FROM workspace_job_intents'));assert.ok(queueGuard);
  f.sqlite.prepare('INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,?,?,?,?,?,0,0)').run('foreign-owner','foreign-intent','review_generate','foreign-key','{}',now,'pending');
  assert.ok(await f.db.prepare('SELECT 1 WHERE '+queueGuard.sql).bind(...queueGuard.bindings).first());
  f.sqlite.prepare('INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,?,?,?,?,?,0,0)').run(owner,'late-owner-intent','review_generate','owner-key','{}',now,'pending');
  assert.equal(await f.db.prepare('SELECT 1 WHERE '+queueGuard.sql).bind(...queueGuard.bindings).first(),null);
  assert.ok(quote.growth.every(row=>row.bytes>=0&&row.rows>=0));
 }finally{f.sqlite.close();}
});
