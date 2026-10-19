import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactFixture,artifactNow as now} from './fixtures/agent-artifact.ts';
import {readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {executeWorkspaceCommand,type MutationPlan,type CommandHandlerRegistry,type PrepareContext} from '../lib/workspace-transaction.ts';
import {agentArtifactCommandHandlers} from '../lib/agents/artifact-handlers.ts';
import {authorizeAgentArtifactAttempt,readOwnedAgentArtifact} from '../lib/agents/artifact-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {attachmentRecordSchema} from '../lib/evidence-module.ts';
import {stageAttachmentUpload,createR2BlobStore} from '../lib/attachments.ts';
let serial=0;
async function fixture(){
 const f=await artifactFixture(),namespace=(await getWorkspaceNamespaces(f.db,f.owner))!.blobNamespace,store=createR2BlobStore(f.bucket),sha256=await contentHash('hello');
 const lease={attemptId:f.lease.attemptId,leaseToken:f.lease.leaseToken};
 const authority=await authorizeAgentArtifactAttempt(f.db,f.principal,lease,now);
 const material={attemptId:authority.attemptId,logicalType:'summary' as const,sha256,bytes:5,guard:authority.guard};
 return {...f,namespace,store,material,artifactLease:lease};
}
const reserve={type:'jobs.artifact.reserve',logicalType:'summary',sha256:'',value:{filename:'report.txt',mimeType:'text/plain',expectedBytes:5}};
function snapshot(f:Awaited<ReturnType<typeof fixture>>){return canonical(Object.fromEntries(['attachments','attachment_usage','attachment_blob_objects','agent_artifacts','audit_events','workspace_mutations','workspace_job_intents','workspace_command_guards','workspace_assertions','workspaces'].map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=? ORDER BY rowid').all(f.owner)])));}
async function send(f:Awaited<ReturnType<typeof fixture>>,command:unknown,options:{db?:SqlDatabase;mutate?:(plan:MutationPlan)=>void}={}){
 const handlers:CommandHandlerRegistry=new Map([...agentArtifactCommandHandlers].map(([type,handler])=>[type,{async prepare(ctx:PrepareContext){const plan=await handler.prepare(ctx);options.mutate?.(plan);return plan;}}]));
 const material=typeof command==='object'&&command!==null&&'type' in command&&command.type==='jobs.artifact.finalize'&&'id' in command?(await readOwnedAgentArtifact(f.db,f.principal,f.artifactLease,String(command.id),now)).material:f.material;
 return executeWorkspaceCommand(f.owner,{protocolVersion:1,expectedRevision:(await readCurrent(f.db,f.owner,now)).revision,mutationId:'artifact-central-'+String(++serial).padStart(16,'0'),command},{db:options.db??f.db,handlers,now:()=>now,agentArtifact:material,attachmentAccess:{ownerNamespace:f.namespace,store:f.store}});
}
test('valid device artifact reserve keeps connector attribution and never creates execution work',async()=>{
 const f=await fixture();try{
  const result=await send(f,{...reserve,sha256:f.material.sha256});assert.equal(result.status,'committed');
  const event=f.sqlite.prepare('SELECT origin,source_ref FROM audit_events WHERE user_id=? AND kind=\'jobs.artifact.reserve\'').get(f.owner);assert.equal(event?.origin,'connector');assert.equal(event?.source_ref,f.lease.attemptId);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_artifacts WHERE user_id=?').get(f.owner)?.n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').get(f.owner)?.n,1);assert.equal(f.sqlite.prepare('SELECT id FROM workspace_job_intents WHERE user_id=?').get(f.owner)?.id,f.intentId);
 }finally{f.sqlite.close();}
});
test('central compiler rejects quota undercharge and hidden planning edits atomically',async()=>{
 for(const mutation of ['quota','planning'] as const){const f=await fixture();try{
  const before=snapshot(f);await assert.rejects(()=>send(f,{...reserve,sha256:f.material.sha256},{mutate(plan){if(mutation==='quota')plan.writes.find(row=>row.table==='attachment_usage')!.value={bytes:0,files:0};else plan.planningAfter={...plan.planningAfter,projects:plan.planningAfter.projects.map((project,index)=>index?project:{...project,name:'hidden change'})};}}));assert.equal(snapshot(f),before);
 }finally{f.sqlite.close();}}
});
test('private attempt epoch changing immediately before atomic batch prevents all artifact side effects',async()=>{
 const f=await fixture();try{
  const before=snapshot(f);const raced:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=1 WHERE user_id=?').run(f.owner);return f.db.batch(statements);}};
  await assert.rejects(()=>send(f,{...reserve,sha256:f.material.sha256},{db:raced}));assert.equal(snapshot(f),before);
 }finally{f.sqlite.close();}
});
test('finalize cannot rewrite reserved immutable metadata while presenting correct verified bytes',async()=>{
 const f=await fixture();try{
  assert.equal((await send(f,{...reserve,sha256:f.material.sha256})).status,'committed');
  const row=f.sqlite.prepare('SELECT payload_json FROM attachments WHERE user_id=?').get(f.owner)!;const record=attachmentRecordSchema.parse(JSON.parse(row.payload_json as string));
  assert.equal((await stageAttachmentUpload(f.owner,record,new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('hello'));controller.close();}}),f.store,{ownerNamespace:f.namespace,now})).status,'staged');
  const before=snapshot(f);await assert.rejects(()=>send(f,{type:'jobs.artifact.finalize',id:record.id},{mutate(plan){const write=plan.writes.find(item=>item.table==='attachments')!;write.value={...(write.value as Record<string,import('../lib/workspace-protocol.ts').JsonValue>),filename:'rewritten.txt'};}}));assert.equal(snapshot(f),before);
 }finally{f.sqlite.close();}
});
