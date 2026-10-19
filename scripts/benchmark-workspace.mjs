import {registerHashWorkDiagnostics} from '../lib/hash-work-diagnostics.ts';
// Actual isolated SQLite and Miniflare D1 benchmark. Synthetic owner data only.
// No production latency, private ingress, provider, model or physical-device claim.
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {registerRecoverabilityDiagnostics} from '../lib/recoverability-diagnostics.ts';
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
import {readSources} from '../lib/sources/http.ts';
import {readRuntime} from '../lib/runtime/store.ts';
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
 sqlite:{planningRead:2500,evidenceRead:5000,indexedOwnerPage:250,fullExport:10000,jsonParse:500,strictBundleParse:5000,canonicalJsonHash:3000,reviewedRestore:30000,sourceIdentityRead:1500,runtimeIdentityRead:1500,concurrentSessionRead:1500,concurrentSessionSave:2000,concurrentWave:30000},
 miniflareD1:{planningRead:7500,evidenceRead:20000,indexedOwnerPage:2500,fullExport:30000,jsonParse:500,strictBundleParse:5000,canonicalJsonHash:3000,reviewedRestore:60000,sourceIdentityRead:1500,runtimeIdentityRead:1500,concurrentSessionRead:1500,concurrentSessionSave:2000,concurrentWave:60000},
};
const output=new URL('../benchmark-results/workspace.json',import.meta.url);
const report={format:'control-room-synthetic-benchmark-v1',source,startedAt:new Date().toISOString(),environment:{node:process.version,v8:process.versions.v8,platform:platform(),arch:arch(),cpuModel:cpus()[0]?.model??'unreported',availableParallelism:availableParallelism(),totalMemoryBytes:totalmem(),miniflareLockedVersion:JSON.parse(await readFile(new URL('../node_modules/miniflare/package.json',import.meta.url),'utf8')).version},method:{warmups,samples,percentile:'nearest rank; p95 is the largest of five measured samples',timing:'host performance.now; includes actual database binding round trips where used; setup excluded',budgetsMilliseconds:budgets,thresholdMeaning:'Explicit coarse CI regression gates, not production service-level objectives.',limits:{planning:WORKSPACE_LIMITS,evidenceRead:EVIDENCE_SNAPSHOT_LIMITS,bundle:BUNDLE_LIMITS,d1Recovery:BACKUP_LIMITS,importStaging:IMPORT_STAGING_LIMITS,ownerTables:OWNER_TABLES.length}},engines:[],errors:[],limitations:['Synthetic isolated metadata only; no live owner, hosted D1/R2 network, physical device, provider or model.','Shared Actions CPU and local Miniflare transport vary; five samples provide a coarse regression signal, not a statistically stable tail estimate.','The large case approaches planning record caps and the default D1 metadata recovery byte bound; it does not claim all independent maxima fit simultaneously.','Restore includes real quarantine, private recovery snapshot, receipt, audit and guarded central command; no fake adapter or timing subtraction.']};
report.environment.initialNodeMemoryBytes=process.memoryUsage();
const commandProfiling=process.env.CONTROL_ROOM_PROFILE_COMMANDS==='1';
report.method.commandProfiling={enabled:commandProfiling,activation:'CONTROL_ROOM_PROFILE_COMMANDS=1',scope:'Node benchmark only; one stable DB wrapper per engine',limits:{commandFrames:100,intervalsPerCommand:1024,sequenceEntriesPerCommand:128,recoveryPhasesPerCommand:64},interpretation:'Binding await durations overlap. Union is used for coverage; outside-observed-await wall includes admission waiting, JS/hash/validation and all other unobserved awaits, and is not a CPU attribution. No SQL, parameters, owner IDs, command bodies or result rows are recorded.'};

const commandProfileContext=new AsyncLocalStorage();

const hashWorkProfiling=commandProfiling&&process.env.CONTROL_ROOM_PROFILE_HASH_WORK==='1';
report.method.hashWorkProfiling={enabled:hashWorkProfiling,synchronousCpu:'current Node thread CPU when process.threadCpuUsage exists; null otherwise',nativeAwait:'SHA Promise interval includes native queue, native service and event-loop resume; those cannot be separated by the public Promise API',limits:{shaIntervals:4096,syncIntervals:16384,phaseStageRows:80},interpretation:'Profiling overhead is not an acceptance result. Sync wall/CPU stage sums may nest; interval unions avoid double counting wall coverage. Bytes count native SHA input bytes, not owner content.'};
function threadCpu(){try{return typeof process.threadCpuUsage==='function'?process.threadCpuUsage():null;}catch{return null;}}
function intervalUnion(intervals){let total=0,end=0;for(const[start,stop]of [...intervals].sort((a,b)=>a[0]-b[0])){total+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop);}return total;}
function hashWorkSummary(frame,wall){
 if(!hashWorkProfiling)return null;
 const work=frame.hashWork,all=[...frame.intervals,...work.shaIntervals,...work.syncIntervals];
 return {stages:work.stages,shaAwaitUnionMilliseconds:work.shaTruncated?null:intervalUnion(work.shaIntervals),syncWallUnionMilliseconds:work.syncTruncated?null:intervalUnion(work.syncIntervals),observedSqlShaSyncUnionMilliseconds:frame.intervalsTruncated||work.shaTruncated||work.syncTruncated?null:intervalUnion(all),residualWallMilliseconds:frame.intervalsTruncated||work.shaTruncated||work.syncTruncated?null:Math.max(0,wall-intervalUnion(all)),shaIntervalsTruncated:work.shaTruncated,syncIntervalsTruncated:work.syncTruncated};
}
const stopHashWorkDiagnostics=hashWorkProfiling?registerHashWorkDiagnostics(stage=>{
 const frame=commandProfileContext.getStore();if(!frame)return;
 const phase=frame.currentRecoveryPhase??'outside-recovery',started=performance.now(),cpu=stage==='sha-await'?null:threadCpu();
 return bytes=>{
 const stopped=performance.now(),elapsed=Math.max(0,stopped-started),after=cpu?threadCpu():null,key=phase+':'+stage;
 const work=frame.hashWork,stat=work.stages[key]??={phase,stage,calls:0,bytes:0,sumWallMilliseconds:0,maximumWallMilliseconds:0,sumThreadCpuMilliseconds:cpu?0:null};
 stat.calls++;stat.bytes+=bytes;stat.sumWallMilliseconds+=elapsed;stat.maximumWallMilliseconds=Math.max(stat.maximumWallMilliseconds,elapsed);
 if(cpu&&after&&stat.sumThreadCpuMilliseconds!==null)stat.sumThreadCpuMilliseconds+=Math.max(0,after.user+after.system-cpu.user-cpu.system)/1000;else stat.sumThreadCpuMilliseconds=null;
 const intervals=stage==='sha-await'?work.shaIntervals:work.syncIntervals,limit=stage==='sha-await'?4096:16384;
 if(intervals.length<limit)intervals.push([started-frame.startedAt,stopped-frame.startedAt]);else if(stage==='sha-await')work.shaTruncated=true;else work.syncTruncated=true;
 };
}):()=>{};

function sqlClass(sql){
 const upper=sql.toUpperCase(),read=/^\s*(SELECT|PRAGMA|EXPLAIN)\b/u.test(upper)||/^\s*WITH PRIVATE_CAPACITY_OWNER\b/u.test(upper);
 // Closed, compile-time categories only. Priority prevents composed quota and
 // admission SQL from being mislabeled by an incidental audit/table reference.
 let family='owner_module_or_guard';
 if(/PRIVATE_CAPACITY_OWNER/u.test(upper))family='private_capacity';
 else if(/SQLITE_MASTER|PRAGMA TABLE_INFO/u.test(upper))family='schema_contract';
 else if(/WORKSPACE_MUTATION_EPOCHS/u.test(upper)&&/WORKSPACE_MUTATIONS/u.test(upper))family=/\bWORKSPACES\b/u.test(upper)?'mutation_admission':'mutation_final_receipt';
 else if(/COUNT\(\*\).*WORKSPACE_MUTATIONS/u.test(upper))family='receipt_count';
 else if(/WORKSPACE_MUTATIONS/u.test(upper))family='receipt';
 else if(/WORKSPACE_MUTATION_EPOCHS|MUTATION_ID/u.test(upper))family='mutation_authority';
 else if(/SELECT\s+W\.CONTENT,W\.REVISION,W\.UPDATED_AT/u.test(upper))family='workspace_current';
 else if(/SELECT DISTINCT ENTITY_ID FROM AUDIT_EVENTS/u.test(upper))family='baseline_removal';
 else if(/AGENT_JOB_STATE/u.test(upper)&&/APPROVAL_ID IS NOT NULL/u.test(upper)&&/LIMIT 13/u.test(upper))family='terminal_reserve';
 else if(/WORKSPACE_SOURCE_NAMESPACES/u.test(upper))family='namespaces';
 else if(/OPERATIONAL_WATERMARK|OPERATIONAL_STREAM|STREAM_WATERMARK/u.test(upper))family='operational_watermark';
 else if(/FROM AUDIT_EVENTS/u.test(upper)&&/EVENT_ID\s*>/u.test(upper))family='audit_page';
 else if(/SELECT ID,\s*ROW_REVISION,\s*PAYLOAD_JSON,\s*CONTENT_HASH/u.test(upper))family='physical_page';
 else if(/WORKSPACE_EXECUTION_STATE/u.test(upper))family='execution_epoch';
 else if(/WORKSPACE_JOB_INTENTS/u.test(upper))family='job_authority';
 else if(/BACKUP|ATTACHMENT_BLOB/u.test(upper))family='recovery_ledger';
 else if(/AUDIT_/u.test(upper))family='audit_other';
 else if(/\bWORKSPACES\b/u.test(upper))family='planning_metadata';
 return {read,family};
}
function profileDatabase(base){
 const native=new WeakMap();
 const observed=async(method,classification,statements,operation,members)=>{
  const frame=commandProfileContext.getStore();if(!frame)return operation();
  frame.rpcCount++;frame.statementCount+=statements;frame.calls[method]=(frame.calls[method]??0)+1;
  const aggregate=frame.classes[classification]??={calls:0,statements:0,sumAwaitMilliseconds:0};aggregate.calls++;aggregate.statements+=statements;
  const started=performance.now(),entry={method,family:classification,statements,...(members?{members}:{}),startedMilliseconds:started-frame.startedAt,awaitMilliseconds:null};if(frame.sequence.length<128)frame.sequence.push(entry);else frame.sequenceTruncated=true;try{return await operation();}finally{const ended=performance.now();entry.awaitMilliseconds=ended-started;aggregate.sumAwaitMilliseconds+=ended-started;frame.sumAwaitMilliseconds+=ended-started;if(frame.intervals.length<1024)frame.intervals.push([started-frame.startedAt,ended-frame.startedAt]);else frame.intervalsTruncated=true;}
 };
 const statement=(value,classification)=>{
  const wrapped={bind:(...values)=>statement(value.bind(...values),classification),first:()=>observed('first',classification.family,1,()=>value.first()),all:()=>observed('all',classification.family,1,()=>value.all()),run:()=>observed('run',classification.family,1,()=>value.run())};
  native.set(wrapped,{value,classification});return wrapped;
 };
 // This single wrapper identity is retained for the whole engine, including
 // warmups, so DB-keyed schema/contract caches are not invalidated per command.
 return {prepare:sql=>statement(base.prepare(sql),sqlClass(sql)),batch:statements=>{const rows=statements.map(value=>native.get(value));return observed('batch',rows.every(row=>row?.classification.read)?'read_batch':'write_or_guard_batch',statements.length,()=>base.batch(statements.map((value,index)=>rows[index]?.value??value)),Object.fromEntries([...new Set(rows.map(row=>row?.classification.family??'unclassified'))].sort().map(family=>[family,rows.filter(row=>(row?.classification.family??'unclassified')===family).length])));}};
}
function profileSummary(frame,wallMilliseconds,status){
 let covered=0,end=0;for(const [start,stop]of frame.intervals.sort((left,right)=>left[0]-right[0])){covered+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop);}
 return {wave:frame.wave,session:frame.session,ownerClass:frame.ownerClass,status,wallMilliseconds,rpcCount:frame.rpcCount,statementCount:frame.statementCount,calls:frame.calls,classes:frame.classes,sumObservedBindingAwaitMilliseconds:frame.sumAwaitMilliseconds,observedAwaitUnionMilliseconds:frame.intervalsTruncated?null:covered,wallOutsideObservedBindingAwaitMilliseconds:frame.intervalsTruncated?null:Math.max(0,wallMilliseconds-covered),intervalsTruncated:frame.intervalsTruncated,sequence:frame.sequence,sequenceTruncated:frame.sequenceTruncated,recoveryPhases:frame.recoveryPhases,recoveryPhasesTruncated:frame.recoveryPhasesTruncated,hashWork:hashWorkSummary(frame,wallMilliseconds)};
}
async function profiledCommand(engine,session,wave,operation){
 if(!commandProfiling)return operation();
 const frame={startedAt:performance.now(),wave,session:session.index,ownerClass:session.index<10?'contended_near_bound':'independent_small',rpcCount:0,statementCount:0,calls:{},classes:{},sumAwaitMilliseconds:0,intervals:[],intervalsTruncated:false,sequence:[],sequenceTruncated:false,recoveryPhases:[],recoveryPhasesTruncated:false,currentRecoveryPhase:null,hashWork:{stages:{},shaIntervals:[],syncIntervals:[],shaTruncated:false,syncTruncated:false}};
 let status='threw';try{const value=await commandProfileContext.run(frame,operation);status=value.status;return value;}
 finally{engine.commandProfiles??=[];if(engine.commandProfiles.length<100){const row=profileSummary(frame,performance.now()-frame.startedAt,status);engine.commandProfiles.push(row);console.log(JSON.stringify({event:'controlled_command_profile',engine:engine.name,...row}));}}
}

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

async function insertModule(db,table,id,value){
 const columns=moduleColumnNames(table),projection=await moduleProjection(table,id,value),names=['user_id','id','row_revision','payload_json','content_hash',...columns],values=[owner,id,1,canonical(value),await contentHash(canonical(value)),...columns.map(column=>projection[column])];
 await db.prepare('INSERT INTO '+table+' ('+names.join(',')+') VALUES ('+names.map(()=>'?').join(',')+')').bind(...values).run();
}
async function identityReadFixtures(db,model){
 await loadWorkspace(db,'different-synthetic-owner',()=>createSeedWorkspace(now),now);
 const projectId=model.workspace.projects[0].id;
 const connection={id:'perf-connection',provider:'documents',label:'Synthetic identity benchmark',accessMode:'interactive',enabled:true,archivedAt:null};
 const target={id:'perf-source',connectionId:connection.id,projectId,kind:'document',providerResourceId:'selected-synthetic-resource',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:600,selectionVersion:1,archivedAt:null};
 const device={id:'perf-device',label:'Synthetic never-enrolled device',createdAt:now,archivedAt:null};
 const configuration={id:'perf-runtime-configuration',deviceId:device.id,projectId,manifest:{id:'pc-command-center',version:1,enabled:true,capabilities:['read.health','read.summary'],endpointAlias:'perf-pc'},selectedGpuAlias:null};
 for(const [table,id,value]of [['source_connections',connection.id,connection],['source_targets',target.id,target],['devices',device.id,device],['runtime_adapter_configurations',configuration.id,configuration]])await insertModule(db,table,id,value);
 return {connection,target,device,configuration};
}
async function concurrentSessions(engine,db){
 engine.stage='concurrent_fixture';
 // Twenty independently retained command envelopes. Ten deliberately contend on
 // one near-cap owner revision; ten address distinct small synthetic owners.
 const independent=Array.from({length:10},(_,index)=>owner+'-independent-'+index);
 for(const user of independent)await loadWorkspace(db,user,()=>createSeedWorkspace(now),now);
 const sessions=await Promise.all(Array.from({length:20},async(_,index)=>{
  const user=index<10?owner:independent[index-10],before=await readCurrent(db,user,now),marker='Synthetic session '+index+' wave ',capture=before.workspace.captures[0];
  assert.ok(capture);
  return {index,user,captureId:capture.id,marker,initialRevision:before.revision};
 }));
 const readTimes=[],saveTimes=[],waves=[];
 for(let wave=0;wave<samples;wave++){
  engine.stage='concurrent_wave_'+wave;
  const snapshots=await Promise.all(sessions.map(async session=>{const start=performance.now(),value=await readCurrent(db,session.user,now);readTimes.push(performance.now()-start);return value;}));
  const inputs=await Promise.all(sessions.map(async(session,index)=>({protocolVersion:1,expectedRevision:snapshots[index].revision,mutationId:await issueMutationId(db,session.user,now),command:{type:'capture.update',id:session.captureId,patch:{body:session.marker+wave}}})));
  const started=performance.now();
  const outcomes=await Promise.all(sessions.map(async(session,index)=>{
   const start=performance.now();const result=await profiledCommand(engine,session,wave,()=>executeWorkspaceCommand(session.user,inputs[index],{db,handlers:workspaceHandlers,now:()=>now}));saveTimes.push(performance.now()-start);return result;
  }));
  const elapsed=performance.now()-started;assert.ok(elapsed>0);waves.push(elapsed);
  assert.equal(outcomes.filter(result=>result.status==='committed').length,11,'Exactly one same-owner CAS and all independent-owner commands commit.');
  assert.equal(outcomes.filter(result=>result.status==='conflict').length,9,'Nine stale same-owner revisions must conflict without silent overwrite.');
  const winningIndex=outcomes.findIndex((result,index)=>index<10&&result.status==='committed');assert.ok(winningIndex>=0);
  for(let index=0;index<sessions.length;index++){
   const session=sessions[index],current=await readCurrent(db,session.user,now),expectedIndex=index<10?winningIndex:index;
   assert.equal(current.revision,snapshots[index].revision+1);
   assert.equal(current.workspace.captures.find(row=>row.id===session.captureId).body,sessions[expectedIndex].marker+wave);
   if(index>=10)assert.ok(!current.workspace.captures.some(row=>row.body===sessions[winningIndex].marker+wave),'No same-ID capture content crosses owners.');
   const receiptCount=(await db.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=? AND mutation_id=?').bind(session.user,inputs[index].mutationId).first()).n;
   assert.equal(receiptCount,outcomes[index].status==='committed'?1:0);
  }
  // A real replay traverses the central receipt path; it may not append events.
  engine.stage='concurrent_original_replay_'+wave;
  const winner=sessions[winningIndex],auditBefore=(await db.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').bind(winner.user).first()).n;
  const replay=await executeWorkspaceCommand(winner.user,inputs[winningIndex],{db,handlers:workspaceHandlers,now:()=>now});assert.equal(replay.status,'replayed');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').bind(winner.user).first()).n,auditBefore);
 }
 // Each wave has twenty actual promises in flight; SQLite serializes its
 // synchronous binding, while Miniflare D1 includes real local binding transport.
 if(commandProfiling){assert.equal(engine.commandProfiles?.length,100);assert.ok(engine.commandProfiles.every(row=>row.rpcCount>0&&row.statementCount>0&&row.wallMilliseconds>0));engine.commandProfileGroups=[];for(const ownerClass of ['contended_near_bound','independent_small'])for(const status of ['committed','conflict']){const rows=engine.commandProfiles.filter(row=>row.ownerClass===ownerClass&&row.status===status);if(!rows.length)continue;const entry={ownerClass,status,commands:rows.length,p50WallMilliseconds:percentile(rows.map(row=>row.wallMilliseconds),.5),p95WallMilliseconds:percentile(rows.map(row=>row.wallMilliseconds),.95),p50RpcCount:percentile(rows.map(row=>row.rpcCount),.5),p95RpcCount:percentile(rows.map(row=>row.rpcCount),.95),p95ObservedAwaitUnionMilliseconds:rows.every(row=>row.observedAwaitUnionMilliseconds!==null)?percentile(rows.map(row=>row.observedAwaitUnionMilliseconds),.95):null,p95OutsideObservedAwaitMilliseconds:rows.every(row=>row.wallOutsideObservedBindingAwaitMilliseconds!==null)?percentile(rows.map(row=>row.wallOutsideObservedBindingAwaitMilliseconds),.95):null};engine.commandProfileGroups.push(entry);console.log(JSON.stringify({event:'controlled_command_profile_group',engine:engine.name,...entry}));}}
 engine.concurrency={sessions:20,sameOwnerSessions:10,independentOwners:10,waves:samples,commitsPerWave:11,conflictsPerWave:9,duplicateReplayEffects:0,transport:engine.name==='sqlite'?'actual synchronous SQLite binding; not twenty operating-system connections':'actual local Miniflare D1 binding; not hosted network clients'};
 // Preserve all 100 samples rather than selecting a favorable wave.
 for(const [name,values]of [['concurrentSessionRead',readTimes],['concurrentSessionSave',saveTimes]]){
  const p50=percentile(values,.5),p95=percentile(values,.95),budget=budgets[engine.name][name],passed=p95<=budget;engine.measurements.push({operation:name,concurrentSessions:20,samplesMilliseconds:values,p50Milliseconds:p50,p95Milliseconds:p95,budgetMilliseconds:budget,passed});if(!passed)failures.push(engine.name+':'+name);
  console.log(JSON.stringify({engine:engine.name,operation:name,samples:values.length,p50Milliseconds:p50,p95Milliseconds:p95,budgetMilliseconds:budget,passed}));
 }
 const p95=percentile(waves,.95),budget=budgets[engine.name].concurrentWave;engine.concurrentWavesMilliseconds=waves;if(p95>budget)failures.push(engine.name+':concurrentWave');
}

async function runEngine(name,db,model,migrations){
 if(commandProfiling)db=profileDatabase(db);
 const bundle=await exportWorkspaceBundle(db,owner,{now:()=>now}),serialized=JSON.stringify(bundle),bytes=new TextEncoder().encode(serialized),encoded=encodePlanning(model.workspace);
 assert.ok(bytes.byteLength>=BACKUP_LIMITS.d1BundleBytes*.75&&bytes.byteLength<=BACKUP_LIMITS.d1BundleBytes*.82,'The fixture must actually approach the default D1 recovery byte bound.');
 assert.equal(bundle.modules.evidence.records.length,evidenceCount*2);assert.equal(parseWorkspaceBundle(JSON.parse(serialized)).planning.tasks.length,model.workspace.tasks.length);
 const engine={name,status:'running',migrations,sqliteVersion:name==='sqlite'?(await db.prepare('SELECT sqlite_version() AS version').first()).version:null,sqliteVersionAvailability:name==='sqlite'?'reported':'D1 blocks sqlite_version(); Miniflare version recorded separately',fixture:{fixtureSha256:model.fixtureSha256,planningTasks:model.workspace.tasks.length,planningTaskCap:WORKSPACE_LIMITS.tasks,planningCaptures:model.workspace.captures.length,planningCaptureCap:WORKSPACE_LIMITS.captures,recordCapFraction:model.density,evidenceHeads:evidenceCount,evidenceVersions:evidenceCount,normalizedRows:model.rows.length,bundleBytes:bytes.byteLength,bundleSha256:await contentHash(bytes),d1RecoveryByteFraction:bytes.byteLength/BACKUP_LIMITS.d1BundleBytes,compactPlanningBytes:new TextEncoder().encode(encoded).byteLength,statementFillerBytes:model.statementBytes},measurements:[]};report.engines.push(engine);
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
  engine.confirmedRestores=warmups+samples;engine.retainedRecoverySnapshots=(await db.prepare('SELECT COUNT(*) AS count FROM workspace_backups WHERE user_id=?').bind(owner).first()).count;assert.equal(engine.retainedRecoverySnapshots,warmups+samples);const identities=await identityReadFixtures(db,model);
  await measure(engine,'sourceIdentityRead',async()=>{const view=await readSources(db,owner,now);assert.equal(view.connections[0].value.id,identities.connection.id);assert.equal(view.targets[0].value.id,identities.target.id);assert.equal((await readSources(db,'different-synthetic-owner',now)).targets.length,0);});
  await measure(engine,'runtimeIdentityRead',async()=>{const view=await readRuntime(db,owner,now);assert.equal(view.devices[0].device.id,identities.device.id);assert.equal(view.devices[0].enrolled,false);assert.equal(view.devices[0].sources[0].configurationId,identities.configuration.id);assert.equal(view.devices[0].sources[0].observation,null);assert.equal((await readRuntime(db,'different-synthetic-owner',now)).devices.length,0);});
  engine.identityReadCoverage={sourceConnections:1,sourceTargets:1,runtimeDevices:1,runtimeConfigurations:1,liveRuntimeSamples:0,limitation:'Positive metadata identities only. Never-enrolled device and absent observation are verified honestly; no provider or live hardware.'};
  // Only the explicitly enabled profiler installs diagnostics. Capture the ALS
  // frame at START so interleaved owners and later completions cannot mix sinks.
  const stopRecoveryDiagnostics=commandProfiling?registerRecoverabilityDiagnostics(db,phase=>{
   const frame=commandProfileContext.getStore();if(!frame)return;
   if(frame.recoveryPhases.length>=64){frame.recoveryPhasesTruncated=true;return;}
   const entry={phase,startedMilliseconds:performance.now()-frame.startedAt,elapsedMilliseconds:null};frame.recoveryPhases.push(entry);frame.currentRecoveryPhase=phase;
   return elapsedMilliseconds=>{entry.elapsedMilliseconds=elapsedMilliseconds;if(frame.currentRecoveryPhase===phase)frame.currentRecoveryPhase=null;};
  }):()=>{};
  try{await concurrentSessions(engine,db);}finally{stopRecoveryDiagnostics();}
  engine.finalRevision=(await readCurrent(db,owner,now)).revision;
  engine.status=engine.measurements.every(row=>row.passed)?'passed':'regression-budget-exceeded';
 }catch(error){engine.status='failed';engine.error=failure(error);engine.failureStage=engine.stage??'sequential_measurement';throw error;}
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
 stopHashWorkDiagnostics();
 sqlite?.sqlite.close();if(mf)await mf.dispose();report.finishedAt=new Date().toISOString();report.environment.endingNodeMemoryBytes=process.memoryUsage();report.status=report.errors.length||failures.length?'failed':'passed';report.regressionFailures=failures;
 await mkdir(new URL('../benchmark-results/',import.meta.url),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({source,status:report.status,engines:report.engines.map(engine=>({engine:engine.name,status:engine.status,fixture:engine.fixture,confirmedRestores:engine.confirmedRestores??null,failureStage:engine.failureStage??null,error:engine.error??null})),errors:report.errors,regressionFailures:failures}));
 if(report.status!=='passed')process.exitCode=1;
}
