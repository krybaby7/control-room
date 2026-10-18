import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {executeWorkspaceCommand,type MutationPlan,type CommandHandlerRegistry,type PrepareContext} from '../lib/workspace-transaction.ts';
import {agentArtifactCommandHandlers} from '../lib/agents/artifact-handlers.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {attachmentRecordSchema} from '../lib/evidence-module.ts';
import {stageAttachmentUpload,type BlobStore,type BlobMetadata} from '../lib/attachments.ts';
const owner='artifact-compiler-owner',now='2026-10-18T12:00:00.000Z',attemptId='synthetic-lease-attempt';
let serial=0;
class FixtureBlobStore implements BlobStore{
 available=true;objects=new Map<string,{bytes:Uint8Array;metadata:BlobMetadata}>();
 async put(key:string,bytes:Uint8Array,metadata:BlobMetadata):Promise<'stored'|'exists'>{if(this.objects.has(key))return 'exists';this.objects.set(key,{bytes:bytes.slice(),metadata:{...metadata}});return 'stored';}
 async head(key:string){return this.objects.get(key)?.metadata??null;}
 async get(key:string){const value=this.objects.get(key);return value?{metadata:value.metadata,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(value.bytes.slice());controller.close();}})}:null;}
 async delete(key:string){this.objects.delete(key);}
}
async function fixture(){
 const f=database();await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
 const namespace=(await getWorkspaceNamespaces(f.db,owner))!.blobNamespace,store=new FixtureBlobStore(),sha256=await contentHash('hello');
 f.sqlite.prepare('INSERT OR IGNORE INTO workspace_execution_state(user_id,epoch) VALUES(?,0)').run(owner);
 const material={attemptId,logicalType:'summary' as const,sha256,bytes:5,guard:{sql:'EXISTS(SELECT 1 FROM workspace_execution_state WHERE user_id=? AND epoch=0)',bindings:[owner]}};
 return {...f,namespace,store,material};
}
const reserve={type:'jobs.artifact.reserve',logicalType:'summary',sha256:'',value:{filename:'report.txt',mimeType:'text/plain',expectedBytes:5}};
function snapshot(f:Awaited<ReturnType<typeof fixture>>){return canonical(Object.fromEntries(['attachments','attachment_usage','attachment_blob_objects','agent_artifacts','audit_events','workspace_mutations','workspace_job_intents','workspace_command_guards','workspace_assertions','workspaces'].map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=? ORDER BY rowid').all(owner)])));}
async function send(f:Awaited<ReturnType<typeof fixture>>,command:unknown,options:{db?:SqlDatabase;mutate?:(plan:MutationPlan)=>void}={}){
 const handlers:CommandHandlerRegistry=new Map([...agentArtifactCommandHandlers].map(([type,handler])=>[type,{async prepare(ctx:PrepareContext){const plan=await handler.prepare(ctx);options.mutate?.(plan);return plan;}}]));
 return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:(await readCurrent(f.db,owner,now)).revision,mutationId:'artifact-central-'+String(++serial).padStart(16,'0'),command},{db:options.db??f.db,handlers,now:()=>now,agentArtifact:f.material,attachmentAccess:{ownerNamespace:f.namespace,store:f.store}});
}
test('valid device artifact reserve keeps connector attribution and never creates execution work',async()=>{
 const f=await fixture();try{
  const result=await send(f,{...reserve,sha256:f.material.sha256});assert.equal(result.status,'committed');
  const event=f.sqlite.prepare('SELECT origin,source_ref FROM audit_events WHERE user_id=?').get(owner);assert.equal(event?.origin,'connector');assert.equal(event?.source_ref,attemptId);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_artifacts WHERE user_id=?').get(owner)?.n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').get(owner)?.n,0);
 }finally{f.sqlite.close();}
});
test('central compiler rejects quota undercharge and hidden planning edits atomically',async()=>{
 for(const mutation of ['quota','planning'] as const){const f=await fixture();try{
  const before=snapshot(f);await assert.rejects(()=>send(f,{...reserve,sha256:f.material.sha256},{mutate(plan){if(mutation==='quota')plan.writes.find(row=>row.table==='attachment_usage')!.value={bytes:0,files:0};else plan.planningAfter={...plan.planningAfter,projects:plan.planningAfter.projects.map((project,index)=>index?project:{...project,name:'hidden change'})};}}));assert.equal(snapshot(f),before);
 }finally{f.sqlite.close();}}
});
test('private attempt epoch changing immediately before atomic batch prevents all artifact side effects',async()=>{
 const f=await fixture();try{
  const before=snapshot(f);const raced:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=1 WHERE user_id=?').run(owner);return f.db.batch(statements);}};
  await assert.rejects(()=>send(f,{...reserve,sha256:f.material.sha256},{db:raced}));assert.equal(snapshot(f),before);
 }finally{f.sqlite.close();}
});
test('finalize cannot rewrite reserved immutable metadata while presenting correct verified bytes',async()=>{
 const f=await fixture();try{
  assert.equal((await send(f,{...reserve,sha256:f.material.sha256})).status,'committed');
  const row=f.sqlite.prepare('SELECT payload_json FROM attachments WHERE user_id=?').get(owner)!;const record=attachmentRecordSchema.parse(JSON.parse(row.payload_json as string));
  assert.equal((await stageAttachmentUpload(owner,record,new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('hello'));controller.close();}}),f.store,{ownerNamespace:f.namespace,now})).status,'staged');
  const before=snapshot(f);await assert.rejects(()=>send(f,{type:'jobs.artifact.finalize',id:record.id},{mutate(plan){const write=plan.writes.find(item=>item.table==='attachments')!;write.value={...(write.value as Record<string,import('../lib/workspace-protocol.ts').JsonValue>),filename:'rewritten.txt'};}}));assert.equal(snapshot(f),before);
 }finally{f.sqlite.close();}
});
