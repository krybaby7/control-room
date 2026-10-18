// Actual isolated SQLite and Miniflare D1 benchmark. Synthetic owner data only.
// No production latency, private ingress, provider, model or physical-device claim.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus,availableParallelism,totalmem,platform,arch} from 'node:os';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {database} from '../tests/helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parseWorkspaceExport,WORKSPACE_LIMITS} from '../lib/workspace-validation.ts';
import {encodePlanning} from '../lib/workspace-codec.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {ownerReader,OWNER_TABLES} from '../lib/workspace-modules.ts';
import {moduleColumnNames,moduleProjection} from '../lib/module-columns.ts';
import {versionRowId} from '../lib/version-identity.ts';
import {readEvidenceSnapshot,EVIDENCE_SNAPSHOT_LIMITS} from '../lib/evidence-store.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle,BUNDLE_LIMITS} from '../lib/workspace-export.ts';
import {BACKUP_LIMITS} from '../lib/workspace-backups.ts';
import {stageImport,IMPORT_STAGING_LIMITS} from '../lib/import-staging.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 or newer is required.');
const owner='synthetic-workspace-benchmark-owner',now='2026-10-18T12:00:00.000Z',warmups=1,samples=5,evidenceCount=256;
const source=process.env.CONTROL_ROOM_SOURCE_COMMIT??'local-source-not-recorded';
if(process.env.CI)assert.match(source,/^[a-f0-9]{40}$/,'CI must record the exact checked-out source.');
const budgets={
 sqlite:{planningRead:2500,evidenceRead:5000,indexedOwnerPage:250,fullExport:10000,jsonParse:500,strictBundleParse:5000,canonicalJsonHash:3000,reviewedRestore:30000},
 miniflareD1:{planningRead:7500,evidenceRead:20000,indexedOwnerPage:2500,fullExport:30000,jsonParse:500,strictBundleParse:5000,canonicalJsonHash:3000,reviewedRestore:60000},
};
const output=new URL('../benchmark-results/workspace.json',import.meta.url);
const report={format:'control-room-synthetic-benchmark-v1',source,startedAt:new Date().toISOString(),environment:{node:process.version,v8:process.versions.v8,platform:platform(),arch:arch(),cpuModel:cpus()[0]?.model??'unreported',availableParallelism:availableParallelism(),totalMemoryBytes:totalmem(),miniflareLockedVersion:JSON.parse(await readFile(new URL('../node_modules/miniflare/package.json',import.meta.url),'utf8')).version},method:{warmups,samples,percentile:'nearest rank; p95 is the largest of five measured samples',timing:'host performance.now; includes actual database binding round trips where used; setup excluded',budgetsMilliseconds:budgets,thresholdMeaning:'Explicit coarse CI regression gates, not production service-level objectives.',limits:{planning:WORKSPACE_LIMITS,evidenceRead:EVIDENCE_SNAPSHOT_LIMITS,bundle:BUNDLE_LIMITS,d1Recovery:BACKUP_LIMITS,importStaging:IMPORT_STAGING_LIMITS,ownerTables:OWNER_TABLES.length}},engines:[],errors:[],limitations:['Synthetic isolated metadata only; no live owner, hosted D1/R2 network, physical device, provider or model.','Shared Actions CPU and local Miniflare transport vary; five samples provide a coarse regression signal, not a statistically stable tail estimate.','The large case approaches planning record caps and the default D1 metadata recovery byte bound; it does not claim all independent maxima fit simultaneously.','Restore includes real quarantine, private recovery snapshot, receipt, audit and guarded central command; no fake adapter or timing subtraction.']};
report.environment.initialNodeMemoryBytes=process.memoryUsage();
const failures=[];
function failure(error){return {name:error instanceof Error?error.name:'Error',message:String(error instanceof Error?error.message:error).slice(0,1200)};}
function percentile(values,fraction){return [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*fraction)-1)];}
async function measure(engine,name,operation){
 for(let index=0;index<warmups;index++)await operation();
 const durations=[];for(let index=0;index<samples;index++){const start=performance.now();await operation();const elapsed=performance.now()-start;assert.ok(Number.isFinite(elapsed)&&elapsed>0,'A real positive elapsed sample is required.');durations.push(elapsed);}
 const p50=percentile(durations,.5),p95=percentile(durations,.95),budget=budgets[engine.name][name],passed=p95<=budget;
 engine.measurements.push({operation:name,samplesMilliseconds:durations,p50Milliseconds:p50,p95Milliseconds:p95,budgetMilliseconds:budget,passed});
 console.log(JSON.stringify({engine:engine.name,operation:name,p50Milliseconds:Math.round(p50*100)/100,p95Milliseconds:Math.round(p95*100)/100,budgetMilliseconds:budget,passed}));
 if(!passed)failures.push(engine.name+':'+name);
}
function planning(density){
 const seed=createSeedWorkspace(now),project=seed.projects.find(row=>!row.archivedAt),task=seed.tasks.find(row=>row.projectId===project?.id),capture=seed.captures[0];assert.ok(project&&task&&capture);
 const tasks=Array.from({length:Math.floor(WORKSPACE_LIMITS.tasks*density)},(_,index)=>({...task,id:'perf-task-'+String(index).padStart(4,'0'),projectId:project.id,milestoneId:null,title:'Synthetic benchmark task '+index,notes:'Controlled synthetic read-only performance fixture.',status:'todo',horizon:'now',priority:'normal',dueDate:null,weekly:false,weeklyWeek:null,dependsOn:[],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null,completedAt:null,archivedFromStatus:null,createdAt:now,updatedAt:now}));
 const captures=Array.from({length:Math.floor(WORKSPACE_LIMITS.captures*density)},(_,index)=>({...capture,id:'perf-capture-'+String(index).padStart(4,'0'),title:'Synthetic benchmark capture '+index,body:'Controlled synthetic metadata; no execution or private owner content.',projectId:null,kind:'idea',status:'inbox',sourceUrl:null}));
 return parseWorkspaceExport({...seed,tasks,captures,activity:[]},now);
}
async function records(statementBytes){
 const values=[];for(let index=0;index<evidenceCount;index++){const id='perf-evidence-'+String(index).padStart(4,'0');values.push({table:'evidence_records',id,value:{id,currentVersion:1,archivedAt:null}});values.push({table:'evidence_versions',id:await versionRowId(id,1),value:{id,version:1,basis:'owner-statement',scope:'implementation',title:'Synthetic benchmark context '+index,statement:'Synthetic benchmark context. '+'x'.repeat(statementBytes),observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null}});}
 return values;
}
async function seed(db,model){
 await loadWorkspace(db,owner,()=>model.workspace,now);
 for(let offset=0;offset<model.rows.length;offset+=64){const statements=[];for(const row of model.rows.slice(offset,offset+64)){const columns=moduleColumnNames(row.table),projection=await moduleProjection(row.table,row.id,row.value),names=['user_id','id','row_revision','payload_json','content_hash',...columns],values=[owner,row.id,1,canonical(row.value),await contentHash(canonical(row.value)),...columns.map(column=>projection[column])];statements.push(db.prepare('INSERT INTO '+row.table+' ('+names.join(',')+') VALUES ('+names.map(()=>'?').join(',')+')').bind(...values));}await db.batch(statements);}
}
async function calibrate(){
 // Fitting is setup, never timed. A fixed ASCII payload gives exact byte control.
 const target=Math.floor(BACKUP_LIMITS.d1BundleBytes*.80);
 for(const density of [.90,.85,.80]){
  let workspace;try{workspace=planning(density);}catch{continue;}
  const bare={workspace,rows:await records(0),density,statementBytes:0},probe=database();
  try{await seed(probe.db,bare);const bundle=await exportWorkspaceBundle(probe.db,owner,{now:()=>now}),bytes=new TextEncoder().encode(JSON.stringify(bundle)).byteLength;if(bytes>target)continue;
   const statementBytes=Math.floor((target-bytes)/evidenceCount);assert.ok(statementBytes>=0&&statementBytes<=9000,'Calibrated evidence statement remains within its 10,000-character contract.');
   const model={workspace,rows:await records(statementBytes),density,statementBytes};model.fixtureSha256=await contentHash(canonical({workspace:model.workspace,rows:model.rows}));return model;
  }finally{probe.sqlite.close();}
 }
 throw new Error('The declared near-supported record case no longer fits the default recovery byte bound. Review actual limits; do not silently reduce the case.');
}
async function runEngine(name,db,model,migrations){
 const bundle=await exportWorkspaceBundle(db,owner,{now:()=>now}),serialized=JSON.stringify(bundle),bytes=new TextEncoder().encode(serialized),encoded=encodePlanning(model.workspace);
 assert.ok(bytes.byteLength>=BACKUP_LIMITS.d1BundleBytes*.75&&bytes.byteLength<=BACKUP_LIMITS.d1BundleBytes*.82,'The fixture must actually approach the default D1 recovery byte bound.');
 assert.equal(bundle.modules.evidence.records.length,evidenceCount*2);assert.equal(parseWorkspaceBundle(JSON.parse(serialized)).planning.tasks.length,model.workspace.tasks.length);
 const engine={name,status:'running',migrations,sqliteVersion:(await db.prepare('SELECT sqlite_version() AS version').first()).version,fixture:{fixtureSha256:model.fixtureSha256,planningTasks:model.workspace.tasks.length,planningTaskCap:WORKSPACE_LIMITS.tasks,planningCaptures:model.workspace.captures.length,planningCaptureCap:WORKSPACE_LIMITS.captures,recordCapFraction:model.density,evidenceHeads:evidenceCount,evidenceVersions:evidenceCount,normalizedRows:model.rows.length,bundleBytes:bytes.byteLength,bundleSha256:await contentHash(bytes),d1RecoveryByteFraction:bytes.byteLength/BACKUP_LIMITS.d1BundleBytes,compactPlanningBytes:new TextEncoder().encode(encoded).byteLength,statementFillerBytes:model.statementBytes},measurements:[]};report.engines.push(engine);
 try{
  await measure(engine,'planningRead',async()=>{const value=await readCurrent(db,owner,now);assert.equal(value.workspace.tasks.length,model.workspace.tasks.length);});
  await measure(engine,'evidenceRead',async()=>{const value=await readEvidenceSnapshot(db,owner,now);assert.equal(value.evidenceHeads.length,evidenceCount);assert.equal(value.evidenceVersions.length,evidenceCount);});
  await measure(engine,'indexedOwnerPage',async()=>{const page=await ownerReader(db,owner).list('evidence_versions',{after:'',limit:200});assert.equal(page.length,200);assert.equal((await ownerReader(db,'different-synthetic-owner').list('evidence_versions',{after:'',limit:200})).length,0);});
  await measure(engine,'fullExport',async()=>{const value=await exportWorkspaceBundle(db,owner,{now:()=>now});assert.equal(value.modules.evidence.records.length,evidenceCount*2);});
  await measure(engine,'jsonParse',async()=>{const value=JSON.parse(serialized);assert.equal(value.planning.tasks.length,model.workspace.tasks.length);});
  await measure(engine,'strictBundleParse',async()=>{const value=parseWorkspaceBundle(JSON.parse(serialized));assert.equal(value.modules.evidence.records.length,evidenceCount*2);});
  await measure(engine,'canonicalJsonHash',async()=>{const hash=await contentHash(canonical(bundle));assert.match(hash,/^[a-f0-9]{64}$/);});
  await measure(engine,'reviewedRestore',async()=>{const before=await readCurrent(db,owner,now),stage=await stageImport(db,owner,bytes,now);assert.equal(stage.diagnostics.length,0);const result=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:before.revision,mutationId:await issueMutationId(db,owner,now),command:{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:before.revision,mode:'replace'}},{db,handlers:workspaceHandlers,now:()=>now});assert.equal(result.status,'committed');assert.deepEqual((await readCurrent(db,owner,now)).workspace,model.workspace);});
  const evidence=await readEvidenceSnapshot(db,owner,now);assert.equal(evidence.evidenceVersions.length,evidenceCount);assert.ok(evidence.evidenceVersions.every(row=>row.version===1&&row.statement.length===model.statementBytes+'Synthetic benchmark context. '.length));engine.finalRevision=(await readCurrent(db,owner,now)).revision;
  engine.confirmedRestores=warmups+samples;engine.retainedRecoverySnapshots=(await db.prepare('SELECT COUNT(*) AS count FROM workspace_backups WHERE user_id=?').bind(owner).first()).count;assert.equal(engine.retainedRecoverySnapshots,warmups+samples);engine.status=engine.measurements.every(row=>row.passed)?'passed':'regression-budget-exceeded';
 }catch(error){engine.status='failed';engine.error=failure(error);throw error;}
}
let mf=null,sqlite=null;
try{
 const model=await calibrate();sqlite=database();await seed(sqlite.db,model);const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
 try{await runEngine('sqlite',sqlite.db,model,migrations.length);}catch(error){report.errors.push({engine:'sqlite',...failure(error)});}finally{sqlite.sqlite.close();sqlite=null;}
 mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic performance fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,cf:false});
 const db=await mf.getD1Database('DB');for(const name of migrations){const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const statement of sql.split('--> statement-breakpoint'))if(statement.trim())await db.prepare(statement.trim()).run();}
 await seed(db,model);try{await runEngine('miniflareD1',db,model,migrations.length);}catch(error){report.errors.push({engine:'miniflareD1',...failure(error)});}
}catch(error){report.errors.push({engine:'setup',...failure(error)});}
finally{
 sqlite?.sqlite.close();if(mf)await mf.dispose();report.finishedAt=new Date().toISOString();report.environment.endingNodeMemoryBytes=process.memoryUsage();report.status=report.errors.length||failures.length?'failed':'passed';report.regressionFailures=failures;
 await mkdir(new URL('../benchmark-results/',import.meta.url),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({source,status:report.status,engines:report.engines.map(engine=>({engine:engine.name,status:engine.status,fixture:engine.fixture,confirmedRestores:engine.confirmedRestores??null})),errors:report.errors,regressionFailures:failures}));
 if(report.status!=='passed')process.exitCode=1;
}
