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
import {privateCapacityGuard,privateRowGrowth,PRIVATE_REVOCATION_POOL} from '../lib/private-capacity.ts';
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
  let epochReads=0;const quoteDb={...f.db,prepare(sql:string){if(sql==='SELECT epoch FROM workspace_execution_state WHERE user_id=?')epochReads++;return f.db.prepare(sql);}};
  const quote=await workspacePrivateCapacityGrowth(quoteDb,owner,{plan,before,command,mutationId,commandHash,now,preparedBackup:null});
  // Agent creation quotes both the intent and job state with the exact same
  // persisted epoch. Ordinary task/budget rows contain no epoch at all.
  assert.equal(epochReads,kind==='agent'?1:0);
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

const stageImportId='synthetic-capacity-import',stageHash='c'.repeat(64),stageExpiry='2026-10-18T12:30:00.000Z';
function stage(f:Awaited<ReturnType<typeof fixture>>,revision:number,options:{owner?:string;hash?:string;importId?:string;expires?:string;status?:string}={}){
 const id=crypto.randomUUID();f.sqlite.prepare('INSERT INTO attachment_archive_stages(user_id,id,namespace,source_manifest_hash,manifest_json,created_at,expires_at,target_revision,status,import_id,import_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(options.owner??owner,id,crypto.randomUUID(),stageHash,'{}',now,options.expires??stageExpiry,revision,options.status??'verified',options.importId??stageImportId,options.hash??stageHash);return id;
}
async function stageQuote(f:Awaited<ReturnType<typeof fixture>>){
 const before=await readCurrent(f.db,owner,now),mutationId=crypto.randomUUID(),plan:MutationPlan={planningAfter:before.workspace,writes:[],events:[],jobs:[],importSource:{id:stageImportId,hash:stageHash}},command={type:'workspace.import.commit',mode:'replace',id:stageImportId,hash:stageHash} as unknown as WorkspaceCommand;
 const input={plan,before,command,mutationId,commandHash:'d'.repeat(64),now,preparedBackup:null},quote=await workspacePrivateCapacityGrowth(f.db,owner,input);return {input,quote};
}
function physicalPrivateBytes(f:Awaited<ReturnType<typeof fixture>>){
 let bytes=0;for(const table of PRIVATE_PROFILE_TABLES){const columns=f.sqlite.prepare('PRAGMA table_info('+table+')').all().map(row=>String(row.name)).filter(name=>name!=='user_id').sort(),json="json_object("+columns.flatMap(name=>["'"+name+"'",'"'+name+'"']).join(',')+")";bytes+=Number(f.sqlite.prepare('SELECT COALESCE(SUM(length(CAST('+json+' AS BLOB))+1),0) n FROM '+table+' WHERE user_id=?').get(owner)!.n);}return bytes;
}
function fillPrivateBytes(f:Awaited<ReturnType<typeof fixture>>,target:number){
 const remaining=target-physicalPrivateBytes(f),max=1_700_000,example={id:'capacity-fill-000',row_revision:1,payload_json:'',expires_at:stageExpiry},overhead=new TextEncoder().encode(canonical(example)).byteLength+1,count=Math.ceil(remaining/(max+overhead));assert.ok(count>0&&count<100);let payload=remaining-count*overhead;
 for(let index=0;index<count;index++){const length=Math.min(max,payload);payload-=length;f.sqlite.prepare("INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,replace(hex(zeroblob(?)),'00','x'),?)").run(owner,'capacity-fill-'+String(index).padStart(3,'0'),length,stageExpiry);}
 assert.equal(payload,0);assert.equal(physicalPrivateBytes(f),target);
}
test('reviewed stage activation quotes exact owner/import/hash/revision/expiry scope and guards a late matching stage',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now),id=stage(f,before.revision);
  stage(f,before.revision,{owner:'foreign-stage-owner'});stage(f,before.revision,{hash:'e'.repeat(64)});stage(f,before.revision+1);stage(f,before.revision,{expires:now});stage(f,before.revision,{status:'preparing'});
  const {input,quote}=await stageQuote(f),growth=quote.growth.find(row=>row.table==='attachment_archive_stages');assert.ok(growth);assert.equal(growth.rows,0);assert.equal(growth.bytes,privateRowGrowth('attachment_archive_stages',null,{status:'committed'}).bytes);
  const countGuard=quote.guards.find(guard=>guard.sql.includes('COUNT(*) FROM attachment_archive_stages'));assert.ok(countGuard);assert.ok(await f.db.prepare('SELECT 1 WHERE '+countGuard.sql).bind(...countGuard.bindings).first());
  // A second verified stage arrives after preparation without an editor change.
  const late=stage(f,before.revision),capacity=await privateCapacityGuard(f.db,owner,{growth:quote.growth}),assertions=[...quote.guards,capacity].map((guard,index)=>f.db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+guard.sql+' THEN 1 ELSE 0 END').bind(owner,'stage-count-race-'+index,...guard.bindings));
  await assert.rejects(f.db.batch([...assertions,f.db.prepare("UPDATE attachment_archive_stages SET status='committed' WHERE user_id=? AND import_id=? AND import_hash=? AND status='verified' AND target_revision=? AND expires_at>?").bind(owner,stageImportId,stageHash,input.before.revision,now)]));
  for(const selected of [id,late])assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages WHERE user_id=? AND id=?').get(owner,selected)!.status,'verified');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_assertions').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('actual native private-capacity boundary cannot hide reviewed stage growth behind an unchanged row count',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now),id=stage(f,before.revision),{input,quote}=await stageQuote(f),stageGrowth=quote.growth.find(row=>row.table==='attachment_archive_stages');assert.ok(stageGrowth);
  const withoutStage=quote.growth.filter(row=>row.table!=='attachment_archive_stages'),ordinaryBytes=withoutStage.reduce((sum,row)=>sum+row.bytes,0),limit=64*1024*1024-PRIVATE_REVOCATION_POOL.bytes-PRIVATE_REVOCATION_POOL.framingBytes;
  // Synthetic private metadata fills the actual SQLite byte profile. This is
  // not production owner data and does not grant import or cleanup authority.
  fillPrivateBytes(f,limit-ordinaryBytes);
  const omitted=await privateCapacityGuard(f.db,owner,{growth:withoutStage}),complete=await privateCapacityGuard(f.db,owner,{growth:quote.growth});
  assert.ok(await f.db.prepare('SELECT 1 WHERE '+omitted.sql).bind(...omitted.bindings).first(),'the omitted transition would falsely fit exactly');
  assert.equal(await f.db.prepare('SELECT 1 WHERE '+complete.sql).bind(...complete.bindings).first(),null,'the complete positive transition must be reserved');
  const statements=(proof:typeof complete)=>[
   f.db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+proof.sql+' THEN 1 ELSE 0 END').bind(owner,'stage-exact-capacity',...proof.bindings),
   f.db.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').bind(owner,input.mutationId,input.commandHash,input.before.revision+1,now),
   f.db.prepare("UPDATE attachment_archive_stages SET status='committed' WHERE user_id=? AND import_id=? AND import_hash=? AND status='verified' AND target_revision=? AND expires_at>?").bind(owner,stageImportId,stageHash,input.before.revision,now),
   f.db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(owner,'stage-exact-capacity'),
  ];
  await assert.rejects(f.db.batch(statements(complete)));assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages WHERE user_id=? AND id=?').get(owner,id)!.status,'verified');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,0);
  // Explicit fixture-only release creates precisely the conservative headroom;
  // the helper itself has credited no deletion or speculative future cleanup.
  f.sqlite.prepare('UPDATE workspace_drafts SET payload_json=substr(payload_json,1,length(payload_json)-?) WHERE user_id=? AND id=?').run(stageGrowth.bytes,owner,'capacity-fill-000');
  await f.db.batch(statements(complete));assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages WHERE user_id=? AND id=?').get(owner,id)!.status,'committed');assert.ok(physicalPrivateBytes(f)<=limit);
 }finally{f.sqlite.close();}
});
