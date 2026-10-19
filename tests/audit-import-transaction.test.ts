import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand,type CommandHandler,type CommandHandlerRegistry} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {exportWorkspaceBundle,type WorkspaceBundle} from '../lib/workspace-export.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {stageImport} from '../lib/import-staging.ts';
const now='2026-10-18T12:00:00.000Z';
const sourceOwner='synthetic-source-owner',targetOwner='synthetic-target-owner',thirdOwner='synthetic-third-owner';
const fixtureHandler:CommandHandler={async prepare(context){return {planningAfter:context.before.workspace,writes:[],jobs:[],events:[{id:String(context.command.eventId),kind:'fixture.observation',entityType:'task',entityId:context.before.workspace.tasks[0].id,origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null,changes:[{path:['observation'],before:{exists:false,value:null},after:{exists:true,value:String(context.command.statement)}}]}]};}};
const handlers:CommandHandlerRegistry=new Map([...workspaceHandlers,['fixture.audit',fixtureHandler]]);
const deps=(db:SqlDatabase)=>({db,handlers,now:()=>now});
async function observation(db:SqlDatabase,owner:string,eventId:string,statement:string){const before=await readCurrent(db,owner);return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:before.revision,mutationId:`mutation-${eventId}`,command:{type:'fixture.audit',eventId,statement}},deps(db));}
async function fixture(){const f=database();for(const owner of [sourceOwner,targetOwner,thirdOwner])await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);await observation(f.db,sourceOwner,'source-event-original','Original source claim');await observation(f.db,targetOwner,'target-event-original','Original target story');return f;}
async function stagedCommand(db:SqlDatabase,owner:string,bundle:WorkspaceBundle,id:string){const before=await readCurrent(db,owner),stage=await stageImport(db,owner,new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(stage.diagnostics,[]);return {protocolVersion:1,expectedRevision:before.revision,mutationId:id,command:{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:before.revision,mode:'replace'}};}
async function importBundle(db:SqlDatabase,owner:string,bundle:WorkspaceBundle,id:string){return executeWorkspaceCommand(owner,await stagedCommand(db,owner,bundle,id),deps(db));}
function identities(sqlite:ReturnType<typeof database>['sqlite'],owner:string){return sqlite.prepare('SELECT source_identity,source_hash,event_id FROM audit_import_identities WHERE user_id=? ORDER BY source_identity').all(owner);}
function auditRows(sqlite:ReturnType<typeof database>['sqlite'],owner:string){return sqlite.prepare('SELECT * FROM audit_events WHERE user_id=? ORDER BY event_id').all(owner);}
function snapshot(sqlite:ReturnType<typeof database>['sqlite'],owner:string){return Object.fromEntries(['workspaces','workspace_mutations','audit_events','audit_project_links','audit_import_identities','workspace_backups','workspace_recovery','workspace_execution_state','workspace_job_intents','workspace_command_guards','workspace_assertions'].map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY 1,2`).all(owner)]));}

test('reviewed imports preserve target history, deduplicate original source identities across expanded exports and reject changed claims atomically',async()=>{
 const {db,sqlite}=await fixture();try{
  const first=await exportWorkspaceBundle(db,sourceOwner,{now:()=>now});assert.match(first.source.auditNamespace!,/^[a-f0-9-]{36}$/);const persisted=sqlite.prepare('SELECT audit_namespace FROM workspace_source_namespaces WHERE user_id=?').get(sourceOwner)!;assert.equal(first.source.auditNamespace,persisted.audit_namespace);const originalTarget=auditRows(sqlite,targetOwner)[0];
  assert.equal((await importBundle(db,targetOwner,first,'target-first-audit-import')).status,'committed');assert.deepEqual(auditRows(sqlite,targetOwner).find(row=>row.event_id==='target-event-original'),originalTarget);let imported=identities(sqlite,targetOwner);assert.equal(imported.length,1);const originalIdentity=`audit:${first.source.auditNamespace}:source-event-original`;assert.equal(imported[0].source_identity,originalIdentity);const originalImported=imported[0];
  const claim=auditRows(sqlite,targetOwner).find(row=>row.event_id===originalImported.event_id)!;assert.equal(claim.kind,'imported-history');assert.equal(claim.entity_type,'historical-claim');assert.equal(claim.entity_id,null);const payload=JSON.parse(claim.payload_json as string);assert.equal(payload.actorId,targetOwner);assert.equal(payload.changes[0].after.value.historicalAudit.namespace,first.source.auditNamespace);assert.equal(payload.changes[0].after.value.sourceClaim.payload.actorId,'owner');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_job_intents WHERE user_id=?').get(targetOwner)!.n,0);
  await observation(db,sourceOwner,'source-event-new','A later independent source claim');const expanded=await exportWorkspaceBundle(db,sourceOwner,{now:()=>now});assert.equal(expanded.source.auditNamespace,first.source.auditNamespace);assert.equal((await importBundle(db,targetOwner,expanded,'target-expanded-audit-import')).status,'committed');imported=identities(sqlite,targetOwner);assert.equal(imported.length,2);assert.deepEqual(imported.find(row=>row.source_identity===originalIdentity),originalImported);assert.equal(auditRows(sqlite,targetOwner).filter(row=>row.event_id===originalImported.event_id).length,1);
  const changed=structuredClone(expanded);const row=changed.modules.audit_events.records.find(raw=>(raw as {event_id:string}).event_id==='source-event-original') as {payload:{changes:Array<{after:{value:string}}>}};row.payload.changes[0].after.value='Different text under the same stable source identity';changed.source.sourceHashes.audit_events=await contentHash(canonical(changed.modules.audit_events.records));changed.source.moduleWatermarks.audit_events=changed.source.sourceHashes.audit_events;
  const input=await stagedCommand(db,targetOwner,changed,'target-conflicting-audit-import'),before=snapshot(sqlite,targetOwner);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_backups WHERE user_id=?').get(targetOwner)!.n,2,'snapshot quota is available; this rejection concerns stable provenance');await assert.rejects(executeWorkspaceCommand(targetOwner,input,deps(db)));assert.deepEqual(snapshot(sqlite,targetOwner),before);
 }finally{sqlite.close();}
});

test('re-exported target claims flatten to the original identities on a fresh third owner',async()=>{
 const {db,sqlite}=await fixture();try{
  await observation(db,sourceOwner,'source-event-new','Second source claim');const source=await exportWorkspaceBundle(db,sourceOwner,{now:()=>now});await importBundle(db,targetOwner,source,'target-before-reexport');const target=await exportWorkspaceBundle(db,targetOwner,{now:()=>now});assert.notEqual(target.source.auditNamespace,source.source.auditNamespace);assert.ok(!JSON.stringify(target).includes('audit_import_identities'));const sourcePrefix=`audit:${source.source.auditNamespace}:`;
  await importBundle(db,thirdOwner,target,'third-reexported-target-import');const flattened=identities(sqlite,thirdOwner).filter(row=>String(row.source_identity).startsWith(sourcePrefix));assert.equal(flattened.length,2);assert.deepEqual(flattened,identities(sqlite,targetOwner));const targetIdentity=`audit:${target.source.auditNamespace}:target-event-original`;assert.ok(identities(sqlite,thirdOwner).some(row=>row.source_identity===targetIdentity),'the target owner story remains independently attributable');
  await importBundle(db,thirdOwner,source,'third-direct-original-import');assert.deepEqual(identities(sqlite,thirdOwner).filter(row=>String(row.source_identity).startsWith(sourcePrefix)),flattened);for(const row of flattened)assert.equal(auditRows(sqlite,thirdOwner).filter(event=>event.event_id===row.event_id).length,1);
 }finally{sqlite.close();}
});

test('legacy exports with no namespace use unknown content identity and never guess the source owner',async()=>{
 const {db,sqlite}=await fixture();try{
  const bundle=await exportWorkspaceBundle(db,sourceOwner,{now:()=>now});delete bundle.source.auditNamespace;await importBundle(db,targetOwner,bundle,'target-legacy-unknown-import');const first=identities(sqlite,targetOwner);assert.equal(first.length,1);assert.match(String(first[0].source_identity),/^legacy-unknown:[a-f0-9]{64}$/);const event=auditRows(sqlite,targetOwner).find(row=>row.event_id===first[0].event_id)!,payload=JSON.parse(event.payload_json as string),historical=payload.changes[0].after.value.historicalAudit;assert.equal(historical.namespace,null);assert.equal(historical.eventId,'source-event-original');assert.ok(!JSON.stringify(first).includes(sourceOwner));
  const expanded=structuredClone(bundle);expanded.exportedAt='2026-10-18T12:01:00.000Z';await importBundle(db,targetOwner,expanded,'target-legacy-unknown-repeat');assert.deepEqual(identities(sqlite,targetOwner),first);
 }finally{sqlite.close();}
});
