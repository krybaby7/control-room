import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,CURRENT_WORKSPACE_READ_SQL,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {createFinalRecoveryReads,readCommittedWorkspace,RECOVERY_AUDIT_READ_SQL} from '../lib/closed-workspace-reads.ts';
import {WORKSPACE_NAMESPACE_READ_SQL} from '../lib/workspace-namespaces.ts';
import {MUTATION_ADMISSION_READ_SQL} from '../lib/mutation-admission-reader.ts';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {versionRowId} from '../lib/version-identity.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {getProjectBaseline,baselineRecordId} from '../lib/project-baselines.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-closed-read-owner';
function observed(base:SqlDatabase,afterBatch?:(sqls:string[],result:Awaited<ReturnType<SqlDatabase['batch']>>)=>void){
 const native=new WeakMap<SqlStatement,{statement:SqlStatement;sql:string}>(),calls:string[][]=[];
 const db:SqlDatabase={prepare(sql){let actual=base.prepare(sql);const statement:SqlStatement={bind(...values){actual=actual.bind(...values);native.set(statement,{statement:actual,sql});return statement;},async first<T>(){calls.push([sql]);return actual.first<T>();},async all<T>(){calls.push([sql]);return actual.all<T>();},run(){return actual.run();}};native.set(statement,{statement:actual,sql});return statement;},async batch(statements){const selected=statements.map(statement=>{const entry=native.get(statement);assert.ok(entry);return entry;});const sqls=selected.map(entry=>entry.sql);calls.push(sqls);const result=await base.batch(selected.map(entry=>entry.statement));afterBatch?.(sqls,result);return result;}};
 return {db,calls};
}
async function seed(db:SqlDatabase,user=owner,large=false){const workspace=createSeedWorkspace(now);await loadWorkspace(db,user,()=>workspace,now);if(large){let pending:SqlStatement[]=[];for(let index=0;index<256;index++){
 const id='closed-evidence-'+String(index).padStart(4,'0'),head={id,currentVersion:1,archivedAt:null},value={id,version:1,basis:'owner-statement',scope:'implementation',title:'Synthetic bounded context',statement:'x'.repeat(364),observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
 pending.push(db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash,current_version,archived_at) VALUES(?,?,1,?,?,1,NULL)').bind(user,id,canonical(head),await contentHash(canonical(head))),db.prepare('INSERT INTO evidence_versions(user_id,id,row_revision,payload_json,content_hash,evidence_id,version,recorded_at) VALUES(?,?,1,?,?,?,1,?)').bind(user,await versionRowId(id,1),canonical(value),await contentHash(canonical(value)),id,now));if(pending.length===64){await db.batch(pending);pending=[];}}
 if(pending.length)await db.batch(pending);}
 return workspace;
}
function mixedFinal(sqls:string[]){return sqls.includes(CURRENT_WORKSPACE_READ_SQL)&&sqls.some(sql=>sql.startsWith('WITH recovery_page_scope'));}
async function rpcProof(base:SqlDatabase){
 for(const [large,user,expected]of [[true,owner,12],[false,owner+'-small',11]]as const){const workspace=await seed(base,user,large),log=observed(base),mutationId=large?'closed_read_large_0001':'closed_read_small_0001',command={type:'capture.update',id:workspace.captures[0].id,patch:{body:'Synthetic closed read result'}};
  // Match the canonical benchmark's genuine warmup: first commands also
  // establish existing DB-bound schema contracts, never owner authority.
  const warm=await executeWorkspaceCommand(user,{protocolVersion:1,expectedRevision:1,mutationId:mutationId+'_warmup',command},{db:log.db,handlers:workspaceHandlers,now:()=>now});assert.equal(warm.status,'committed');log.calls.length=0;
  const result=await executeWorkspaceCommand(user,{protocolVersion:1,expectedRevision:2,mutationId,command},{db:log.db,handlers:workspaceHandlers,now:()=>now});assert.equal(result.status,'committed');assert.equal(log.calls.length,expected,'actual production command RPC count');
  const final=log.calls.find(mixedFinal);assert.ok(final);assert.equal(final.length,11);assert.equal(final.filter(sql=>sql.startsWith('WITH recovery_page_scope')).length,8);assert.equal(final.at(-1),WORKSPACE_NAMESPACE_READ_SQL);
  const post=log.calls.find(sqls=>sqls.includes(MUTATION_ADMISSION_READ_SQL)&&sqls.includes(CURRENT_WORKSPACE_READ_SQL));assert.ok(post);assert.equal(post.length,2);
  assert.deepEqual(result.envelope,await readCurrent(base,user,now));assert.equal((await executeWorkspaceCommand(user,{protocolVersion:1,expectedRevision:2,mutationId,command},{db:base,handlers:workspaceHandlers,now:()=>now})).status,'replayed');
 }
}
test('warmed production SQLite paths retain complete final images and use12/11actual RPCs',async()=>{const f=database();try{await rpcProof(f.db);}finally{f.sqlite.close();}});
test('actual Miniflare D1 warmed commands have the same11-statement final cohort,12/11RPC counts and decoded result parity',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readFile,readdir}=await import('node:fs/promises'),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated closed read fixture")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'synthetic-closed-reads'}});
 try{const db=await mf.getD1Database('DB');for(const file of(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort())for(const sql of(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();await rpcProof(db);}finally{await mf.dispose();}
});
for(const mode of ['last-page','namespace','baseline']as const)test(`final snapshot rejects ${mode} mutation between co-batched cohorts`,async()=>{
 const f=database();try{const workspace=await seed(f.db,owner,true),changedPayload=canonical({id:'closed-evidence-0255',currentVersion:1,archivedAt:now}),changedHash=await contentHash(changedPayload);let changed=false;
  const log=observed(f.db,sqls=>{if(changed||!mixedFinal(sqls))return;changed=true;if(mode==='namespace')f.sqlite.prepare('UPDATE workspace_source_namespaces SET audit_namespace=? WHERE user_id=?').run(randomUUID(),owner);
   else if(mode==='last-page')f.sqlite.prepare('UPDATE evidence_records SET payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(changedPayload,changedHash,owner,'closed-evidence-0255');
   else{const project=workspace.projects.find(project=>getProjectBaseline(project));assert.ok(project);const baseline=getProjectBaseline(project)!;const entity=baselineRecordId(project.id,baseline.actions[0].key),event={id:'late-baseline-deletion',kind:'entity.delete',entityType:'task',entityId:entity,changes:[],origin:'owner',actorId:owner,occurredAt:now,sourceRef:null,undoOf:null};f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,0,?,?,?,?,?)').run(owner,event.id,event.kind,event.entityType,event.entityId,now,canonical(event));}
  });await assert.rejects(measureProspectiveRecoverability(log.db,owner,{now}),mode==='namespace'?/Audit namespace changed/:mode==='baseline'?/Workspace boundary changed/:/Normalized row set changed/);assert.equal(changed,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('baseline hydration stays dependent and post-commit admission keeps retired epoch precedence over a refused planning decoder',async()=>{
 const f=database();try{await seed(f.db);const mutationId=await issueMutationId(f.db,owner,now),epoch=mutationId.split('_')[1];f.sqlite.prepare('UPDATE workspace_mutation_epochs SET status=? WHERE user_id=? AND epoch=?').run('retired',owner,epoch);f.sqlite.prepare('UPDATE workspaces SET content=? WHERE user_id=?').run('not JSON',owner);
  const log=observed(f.db),snapshot=await readCommittedWorkspace(log.db,owner,mutationId,now);assert.equal(snapshot.admission.epoch.status,'retired');assert.throws(()=>snapshot.current(),/invalid JSON/);assert.equal(log.calls.length,1);assert.equal(log.calls[0].length,2);
 }finally{f.sqlite.close();}
});
for(const mode of ['missing','extra','malformed']as const)test(`closed read cohorts reject ${mode} returned results without a partial snapshot`,async()=>{
 const f=database();try{await seed(f.db);const log=observed(f.db,(sqls,result)=>{if(!mixedFinal(sqls))return;if(mode==='missing')result.pop();else if(mode==='extra')result.push({meta:{},results:[]});else result[result.length-1]={meta:{}};});await assert.rejects(measureProspectiveRecoverability(log.db,owner,{now}),/closed recovery batch/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);}finally{f.sqlite.close();}
});
test('coordinator rejects foreign bindings, arbitrary SQL and write/forged statements',async()=>{
 const f=database();try{await seed(f.db);const log=observed(f.db),reads=createFinalRecoveryReads(log.db,owner,now,{sources:0});
  assert.throws(()=>reads.reader.prepare('DELETE FROM workspaces WHERE user_id=?').bind(owner),/closed recovery batch/);
  assert.throws(()=>reads.reader.prepare(CURRENT_WORKSPACE_READ_SQL).bind('2026-W42','foreign'),/closed recovery batch/);
  await assert.rejects(reads.reader.prepare(CURRENT_WORKSPACE_READ_SQL).run(),/closed recovery batch/);
  await assert.rejects(reads.reader.batch([f.db.prepare(CURRENT_WORKSPACE_READ_SQL).bind('2026-W42',owner)]),/closed recovery batch/);
  await reads.close();assert.equal(log.calls.length,0);
 }finally{f.sqlite.close();}
});


test('last-cohort namespace remains authoritative after final audit continuation pages',async()=>{
 const f=database();try{await seed(f.db);const insert=f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,?,?,?,?,?,?)');
  for(let index=0;index<450;index++){const event={id:'audit-'+String(index).padStart(4,'0'),kind:'synthetic.change',entityType:'workspace',entityId:null,changes:[],origin:'owner',actorId:owner,occurredAt:now,sourceRef:null,undoOf:null};insert.run(owner,event.id,index,event.kind,event.entityType,event.entityId,now,canonical(event));}
  let auditCohorts=0;const log=observed(f.db,sqls=>{if(!sqls.includes(RECOVERY_AUDIT_READ_SQL))return;auditCohorts++;assert.equal(sqls.at(-1),WORKSPACE_NAMESPACE_READ_SQL);if(auditCohorts===1)f.sqlite.prepare('UPDATE workspace_source_namespaces SET audit_namespace=? WHERE user_id=?').run(randomUUID(),owner);});
  await assert.rejects(measureProspectiveRecoverability(log.db,owner,{now}),/Audit namespace changed/);assert.equal(auditCohorts,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}
});
