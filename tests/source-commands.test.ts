import assert from 'node:assert/strict';
import {parsePlanningImport} from '../lib/workspace-codec.ts';
import {test} from 'node:test';
import {sourceCommandHandlers,sourceCommandSchema} from '../lib/sources/commands.ts';
import {sourceConfigurationHash} from '../lib/background/job-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {taskFixture} from './helpers/workspace.ts';
import {versionRowId} from '../lib/version-identity.ts';
import type {PrepareContext,MutationPlan} from '../lib/workspace-transaction.ts';
import type {RegisteredOwnerTable,ModuleRow} from '../lib/workspace-modules.ts';
import type {SourceConnection,SourceTarget,SourceSyncState,SourceProposal,SourceObservation} from '../lib/sources/contracts.ts';
import type {JsonValue,WorkspaceCommand} from '../lib/workspace-protocol.ts';
const now='2026-10-18T12:00:00.000Z';
async function fixture(){
 let workspace=createSeedWorkspace(now);const projectId=workspace.projects[0].id;workspace.tasks=[taskFixture('owner-task',{projectId,notes:'Original owner notes',status:'done',completedAt:'2026-10-10T10:00:00.000Z',weekly:false,evidence:'Owner history'})];workspace.milestones=[];workspace.captures=[];workspace=parsePlanningImport(workspace,now);
 const connection:SourceConnection={id:'connection',provider:'github',label:'Selected GitHub',accessMode:'interactive',enabled:true,archivedAt:null};
 const target:SourceTarget={id:'target',connectionId:connection.id,projectId,kind:'github_repository',providerResourceId:'42',canonicalUrl:'https://github.com/owner/repository',selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null};
 const rows=new Map<string,ModuleRow>();
 async function put(table:RegisteredOwnerTable,value:unknown,rowRevision=1,id?:string){const key=id??(value as {id:string}).id;rows.set(`${table}:${key}`,{id:key,row_revision:rowRevision,payload_json:JSON.stringify(value),content_hash:await contentHash(canonical(value))});}
 await put('source_connections',connection);await put('source_targets',target);
 let resumeAllowed=true;
 const state:SourceSyncState={sourceId:target.id,operationalRevision:1,configurationHash:await sourceConfigurationHash(connection,target),executionEpoch:1,paused:true,cursor:null,etag:null,attemptedAt:null,lastSuccessAt:null,lastSourceRevision:null,failure:null,retryAt:null,failureCount:0};
 const context:PrepareContext={userId:'owner',mutationId:'source-command-fixture-0001',before:{workspace,revision:1,updatedAt:now},command:{type:'sources.pause',id:target.id,expectedRowRevision:1},now,query:{async get(table,id){return rows.get(`${table}:${id}`)??null;},async list(table,{after='',limit=100}={}){return [...rows.entries()].filter(([key])=>key.startsWith(`${table}:`)).map(([,row])=>row).filter(row=>row.id>after).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).slice(0,limit);}},async readImport(){throw new Error('No import authority');},sourceRuntime:{async state(){return structuredClone(state);},async canResume(){return resumeAllowed;}}};
 async function prepare(command:WorkspaceCommand){return sourceCommandHandlers.get(command.type)!.prepare({...context,command});}
 async function persist(plan:MutationPlan){for(const write of plan.writes){assert.notEqual(write.operation,'delete');await put(write.table,write.value,(write.expectedRowRevision??0)+1,write.id);}}
 async function proposal(fields:SourceProposal['fields']=[{field:'notes',before:'Original owner notes',after:'Suggested contextual note'}]){
 const payload={kind:'check_run',headSha:'a'.repeat(40),requestedHeadSha:'a'.repeat(40),headMatches:true,status:'completed',conclusion:'failure',signal:'check_failure'};
 const observation:SourceObservation={id:'observation',sourceId:target.id,externalId:'provider-observation',sourceRevision:'a'.repeat(40),sourceUpdatedAt:null,observedAt:now,title:'Source fact',canonicalUrl:null,contentDigest:await contentHash(canonical(payload)),payload,origin:'provider-read'};await put('source_observations',observation);
 const value:SourceProposal={id:'proposal',sourceId:target.id,observationRefs:[{id:observation.id,contentDigest:observation.contentDigest}],evidenceRefs:[],entity:{kind:'task',id:'owner-task'},baseWorkspaceRevision:1,fields,rationale:'Source suggestion, not approval.',confidence:'inferred',createdAt:now,state:'pending',dedupKey:'c'.repeat(64),decision:null};await put('source_proposals',value);return {value,observation};}
 return {workspace,connection,target,state,context,rows,put,prepare,persist,proposal,setResume:(value:boolean)=>{resumeAllowed=value;}};
}
const targetValue=(target:SourceTarget)=>{const {id,selectionVersion,archivedAt,...value}=target;void id;void selectionVersion;void archivedAt;return value;};
test('strict create commands generate IDs and paused source controls without provider calls or planning mutation',async()=>{
 const f=await fixture(),before=structuredClone(f.workspace);
 const connectionPlan=await f.prepare({type:'sources.connection.create',value:{provider:'documents',label:' Selected documents ',accessMode:'interactive',enabled:false}});const connection=connectionPlan.writes[0].value as unknown as SourceConnection;assert.match(connection.id,/^[a-f0-9-]{36}$/);assert.equal(connection.label,'Selected documents');assert.equal(connection.archivedAt,null);assert.deepEqual(connectionPlan.jobs,[]);
 const plan=await f.prepare({type:'sources.target.create',value:targetValue(f.target) as unknown as JsonValue});const created=plan.writes[0].value as unknown as SourceTarget;assert.notEqual(created.id,f.target.id);assert.equal(created.selectionVersion,1);assert.equal(plan.sourceControls![0].action,'pause');assert.equal(plan.sourceControls![0].configurationHash,await sourceConfigurationHash(f.connection,created));assert.deepEqual(f.workspace,before);assert.deepEqual(plan.planningAfter,before);
 for(const command of [{type:'sources.connection.create',value:{provider:'github',label:'x',accessMode:'interactive',enabled:true,id:'forged'}},{type:'sources.target.create',value:{...targetValue(f.target),selectionVersion:7}},{type:'sources.target.update',id:f.target.id,patch:{selectedPaths:['../secret']}},{type:'sources.target.update',id:f.target.id,expectedRowRevision:1,patch:{ownerId:'foreign'}}])assert.equal(sourceCommandSchema.safeParse(command).success,false);
});
test('target selection edits increment version and pause; scheduling edits preserve selection version; stale row fails',async()=>{
 const f=await fixture();const plan=await f.prepare({type:'sources.target.update',id:f.target.id,expectedRowRevision:1,patch:{selectedPaths:['README.md']}});const changed=plan.writes[0].value as unknown as SourceTarget;assert.equal(changed.selectionVersion,2);assert.equal(plan.sourceControls![0].action,'pause');assert.ok(plan.preconditions!.some(row=>row.id===f.target.id&&row.expectedHash===f.rows.get(`source_targets:${f.target.id}`)!.content_hash));
 const scheduled=await f.prepare({type:'sources.target.update',id:f.target.id,expectedRowRevision:1,patch:{staleAfterSeconds:7200}});assert.equal((scheduled.writes[0].value as unknown as SourceTarget).selectionVersion,1);
 await assert.rejects(f.prepare({type:'sources.target.update',id:f.target.id,expectedRowRevision:2,patch:{selectedPaths:[]}}),/changed/);
 f.workspace.projects[0].archivedAt=now;await assert.rejects(f.prepare({type:'sources.target.create',value:targetValue(f.target) as unknown as JsonValue}),/active owner project/);
});
test('connection edits pause every selected target; provider mismatch and foreign references reject',async()=>{
 const f=await fixture();await f.put('source_targets',{...f.target,id:'second-target'});
 const plan=await f.prepare({type:'sources.connection.update',id:f.connection.id,expectedRowRevision:1,patch:{enabled:false}});assert.equal(plan.sourceControls!.length,2);assert.ok(plan.sourceControls!.every(control=>control.action==='pause'));
 await assert.rejects(f.prepare({type:'sources.connection.update',id:f.connection.id,expectedRowRevision:1,patch:{provider:'documents'}}),/Existing targets/);
 await assert.rejects(f.prepare({type:'sources.target.create',value:{...targetValue(f.target),connectionId:'foreign'}}),/missing/);
 await assert.rejects(f.prepare({type:'sources.target.create',value:{...targetValue(f.target),kind:'document'}}),/matching provider/);
});
test('archive and restore preserve selection and remain paused until explicit verified resume',async()=>{
 const f=await fixture();const archived=await f.prepare({type:'sources.target.archive',id:f.target.id,expectedRowRevision:1});await f.persist(archived);const value=archived.writes[0].value as unknown as SourceTarget;assert.equal(value.archivedAt,now);assert.equal(value.selectionVersion,1);
 const restored=await f.prepare({type:'sources.target.restore',id:f.target.id,expectedRowRevision:2});assert.equal((restored.writes[0].value as unknown as SourceTarget).archivedAt,null);assert.equal(restored.sourceControls![0].action,'pause');
 const connectionArchive=await f.prepare({type:'sources.connection.archive',id:f.connection.id,expectedRowRevision:1});assert.equal((connectionArchive.writes[0].value as unknown as SourceConnection).archivedAt,now);
 const pause=await f.prepare({type:'sources.pause',id:f.target.id,expectedRowRevision:2});assert.equal(pause.sourceControls![0].action,'pause');
});
test('resume requires live selected owner resource and trusted runtime; refresh only enqueues exact durable intent',async()=>{
 const f=await fixture();f.setResume(false);await assert.rejects(f.prepare({type:'sources.resume',id:f.target.id,expectedRowRevision:1}),/verified/);f.setResume(true);
 const resume=await f.prepare({type:'sources.resume',id:f.target.id,expectedRowRevision:1});assert.equal(resume.sourceControls![0].action,'resume');assert.deepEqual(resume.jobs,[]);
 await assert.rejects(f.prepare({type:'sources.refresh.request',id:f.target.id,expectedRowRevision:1}),/resume/);f.state.paused=false;
 const command={type:'sources.refresh.request',id:f.target.id,expectedRowRevision:1};const first=await f.prepare(command),same=await f.prepare(command);assert.deepEqual(first.jobs,same.jobs);assert.equal(first.jobs[0].kind,'source_refresh');assert.deepEqual(first.jobs[0].payload,{sourceId:f.target.id,configurationHash:f.state.configurationHash});assert.deepEqual(first.integrationJobs,[{intentId:first.jobs[0].id,sourceId:f.target.id,configurationHash:f.state.configurationHash}]);assert.deepEqual(first.writes,[]);
 f.state.configurationHash='b'.repeat(64);await assert.rejects(f.prepare(command),/configuration changed/);f.state.configurationHash=await sourceConfigurationHash(f.connection,f.target);delete f.context.mutationId;await assert.rejects(f.prepare(command),/mutation ID/);
});
test('proposal acceptance requires explicit safe selected fields and preserves status/completion/weekly/IDs/history',async()=>{
 const f=await fixture();await f.proposal([{field:'notes',before:'Original owner notes',after:'Suggested note'},{field:'priority',before:'normal',after:'high'}]);const before=structuredClone(f.workspace.tasks[0]);
 const plan=await f.prepare({type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'accept',reason:'Reviewed exact source and field',selectedFields:['notes'],editedValues:{notes:'Owner reviewed wording'}});
 const after=plan.planningAfter.tasks[0];assert.equal(after.notes,'Owner reviewed wording');assert.equal(after.priority,before.priority);assert.deepEqual({...after,notes:before.notes,updatedAt:before.updatedAt},before);const proposal=plan.writes[0].value as unknown as SourceProposal;assert.equal(proposal.state,'accepted');assert.deepEqual(proposal.decision?.selectedFields,['notes']);assert.ok(plan.events[0].changes.some(change=>canonical(change.path)===canonical(['tasks',before.id,'notes'])));assert.equal(plan.events[0].origin,'owner');assert.equal(plan.events[0].sourceRef,'proposal:proposal');assert.deepEqual(f.workspace.tasks[0],before);assert.deepEqual(plan.jobs,[]);
 for(const command of [{type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'accept',reason:'No selection'},{type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'reject',reason:'No',selectedFields:['notes']}])assert.equal(sourceCommandSchema.safeParse(command).success,false);
 await assert.rejects(f.prepare({type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'accept',reason:'Review',selectedFields:['notes'],editedValues:{priority:'high'}}),/selected fields/);
});
test('proposal selected-field conflict and unsafe lifecycle proposal reject rather than overwrite',async()=>{
 const f=await fixture();await f.proposal();f.workspace.tasks[0].notes='Concurrent owner edit';const command={type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'accept',reason:'Review',selectedFields:['notes']};await assert.rejects(f.prepare(command),/owner field changed/);
 await f.proposal([{field:'status',before:'done',after:'todo'}]);await assert.rejects(f.prepare({...command,selectedFields:['status']}),/cannot be proposed/);
 await f.proposal([{field:'notes',before:'Concurrent owner edit',after:'Proposed'}]);const plan=await f.prepare(command);assert.equal(plan.planningAfter.tasks[0].status,'done');
});
test('proposal immutable observation digests and exact evidence versions must exist in this owner scope',async()=>{
 const f=await fixture(),{value,observation}=await f.proposal(),command={type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'accept',reason:'Review',selectedFields:['notes']};
 await f.put('source_observations',{...observation,payload:{text:'Different provider body'}});await assert.rejects(f.prepare(command),/provenance/);
 await f.put('source_observations',observation);await f.put('source_proposals',{...value,evidenceRefs:[{id:'evidence',version:1}]});await assert.rejects(f.prepare(command),/missing/);
 const physical=await versionRowId('evidence',1);await f.put('evidence_versions',{id:'evidence',version:1,basis:'owner-statement',scope:'implementation',title:'Exact historical context',statement:'Retained',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null},1,physical);
 const accepted=await f.prepare(command);assert.ok(accepted.preconditions!.some(row=>row.id===physical));
 f.rows.delete('source_observations:observation');await assert.rejects(f.prepare(command),/missing/);
});
test('reject/defer keep planning exact, retain reason/provenance and accepted/rejected decisions cannot apply twice',async()=>{
 const f=await fixture();await f.proposal();const before=structuredClone(f.workspace);
 const defer=await f.prepare({type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'defer',reason:'Wait for more source evidence'});assert.deepEqual(defer.planningAfter,before);assert.equal((defer.writes[0].value as unknown as SourceProposal).state,'deferred');await f.persist(defer);
 const reject=await f.prepare({type:'sources.proposal.decide',id:'proposal',expectedRowRevision:2,decision:'reject',reason:'Does not apply to this task'});assert.deepEqual(reject.planningAfter,before);assert.equal((reject.writes[0].value as unknown as SourceProposal).decision?.reason,'Does not apply to this task');await f.persist(reject);
 await assert.rejects(f.prepare({type:'sources.proposal.decide',id:'proposal',expectedRowRevision:3,decision:'accept',reason:'Try again',selectedFields:['notes']}),/no longer pending/);
});
test('actual central command boundary initializes paused runtime and atomically receipts one refresh intent/extension',async()=>{
 const {database}=await import('./helpers/sqlite.ts'),{loadWorkspace,readCurrent}=await import('../lib/workspace-store.ts'),{executeWorkspaceCommand}=await import('../lib/workspace-transaction.ts'),{workspaceHandlers}=await import('../lib/workspace-handlers.ts');
 const f=await fixture(),{db,sqlite}=database();try{
 await loadWorkspace(db,'owner',()=>f.workspace,now);await loadWorkspace(db,'foreign',()=>f.workspace,now);const handlers=workspaceHandlers;
 async function send(command:WorkspaceCommand,mutationId=crypto.randomUUID()){const revision=(await readCurrent(db,'owner',now)).revision;return executeWorkspaceCommand('owner',{protocolVersion:1,expectedRevision:revision,mutationId,command},{db,handlers,now:()=>now});}
 assert.equal((await send({type:'sources.connection.create',value:{provider:'conversation-export',label:'Manual selected source',accessMode:'interactive',enabled:true}})).status,'committed');
 const connectionId=String(sqlite.prepare('SELECT id FROM source_connections WHERE user_id=?').get('owner')!.id);
 assert.equal((await send({type:'sources.target.create',value:{...targetValue(f.target),connectionId,kind:'conversation_export',providerResourceId:'selected-conversation',canonicalUrl:null}})).status,'committed');
 const sourceId=String(sqlite.prepare('SELECT id FROM source_targets WHERE user_id=?').get('owner')!.id);
 assert.equal(sqlite.prepare('SELECT paused FROM source_sync_state WHERE user_id=? AND source_id=?').get('owner',sourceId)!.paused,1);
 assert.equal((await send({type:'sources.resume',id:sourceId,expectedRowRevision:1})).status,'committed');assert.equal(sqlite.prepare('SELECT paused FROM source_sync_state WHERE user_id=? AND source_id=?').get('owner',sourceId)!.paused,0);
 const tables=['workspaces','workspace_mutations','workspace_job_intents','integration_jobs','audit_events','source_sync_state'],snapshot=()=>Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
 const before=snapshot(),mutationId='public-source-refresh-retry-0001',input={protocolVersion:1,expectedRevision:4,mutationId,command:{type:'sources.refresh.request',id:sourceId,expectedRowRevision:1}};
 sqlite.exec("CREATE TRIGGER synthetic_extension_fault BEFORE INSERT ON integration_jobs BEGIN SELECT RAISE(ABORT,'synthetic extension failure'); END;");await assert.rejects(executeWorkspaceCommand('owner',input,{db,handlers,now:()=>now}));assert.deepEqual(snapshot(),before);sqlite.exec('DROP TRIGGER synthetic_extension_fault');
 assert.equal((await executeWorkspaceCommand('owner',input,{db,handlers,now:()=>now})).status,'committed');const committed=snapshot();assert.equal((await executeWorkspaceCommand('owner',input,{db,handlers,now:()=>now})).status,'replayed');assert.deepEqual(snapshot(),committed);
 const job=sqlite.prepare("SELECT id,payload_json FROM workspace_job_intents WHERE kind='source_refresh'").get()!,extension=sqlite.prepare('SELECT intent_id,source_id,configuration_hash FROM integration_jobs').get()!;assert.equal(job.id,extension.intent_id);assert.deepEqual(JSON.parse(String(job.payload_json)),{sourceId,configurationHash:extension.configuration_hash});
 await assert.rejects(executeWorkspaceCommand('foreign',{protocolVersion:1,expectedRevision:1,mutationId:'foreign-source-control-0001',command:{type:'sources.pause',id:sourceId,expectedRowRevision:1}},{db,handlers,now:()=>now}),/missing/);
 assert.equal((await send({type:'sources.pause',id:sourceId,expectedRowRevision:1})).status,'committed');assert.equal(sqlite.prepare('SELECT paused FROM source_sync_state WHERE user_id=? AND source_id=?').get('owner',sourceId)!.paused,1);
 }finally{sqlite.close();}
});
test('actual proposal decision rolls planning/audit/receipt back on failed row CAS write and replays safely',async()=>{
 const {database}=await import('./helpers/sqlite.ts'),{loadWorkspace,readCurrent}=await import('../lib/workspace-store.ts'),{executeWorkspaceCommand}=await import('../lib/workspace-transaction.ts'),{workspaceHandlers}=await import('../lib/workspace-handlers.ts'),{moduleProjection}=await import('../lib/module-columns.ts');
 const f=await fixture(),{value,observation}=await f.proposal(),{db,sqlite}=database();try{
 await loadWorkspace(db,'owner',()=>f.workspace,now);const handlers=workspaceHandlers;
 async function insert(table:RegisteredOwnerTable,record:{id:string}){const projection=await moduleProjection(table,record.id,record as unknown as JsonValue),columns=Object.keys(projection);await db.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash,${columns.join(',')}) VALUES(?,?,1,?,?,${columns.map(()=>'?').join(',')})`).bind('owner',record.id,JSON.stringify(record),await contentHash(canonical(record)),...Object.values(projection)).run();}
 await insert('source_connections',f.connection);await insert('source_targets',f.target);await insert('source_observations',observation);await insert('source_proposals',value);
 const tables=['workspaces','source_proposals','source_observations','audit_events','workspace_mutations'],snapshot=()=>Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
 const before=snapshot(),input={protocolVersion:1,expectedRevision:1,mutationId:'public-source-proposal-retry-0001',command:{type:'sources.proposal.decide',id:value.id,expectedRowRevision:1,decision:'accept',reason:'Explicit owner review',selectedFields:['notes'],editedValues:{notes:'Owner accepted exact contextual suggestion'}}},deps={db,handlers,now:()=>now};
 sqlite.exec("CREATE TRIGGER synthetic_proposal_fault BEFORE UPDATE ON source_proposals BEGIN SELECT RAISE(ABORT,'synthetic proposal write failure'); END;");await assert.rejects(executeWorkspaceCommand('owner',input,deps));assert.deepEqual(snapshot(),before);sqlite.exec('DROP TRIGGER synthetic_proposal_fault');
 assert.equal((await executeWorkspaceCommand('owner',input,deps)).status,'committed');const current=(await readCurrent(db,'owner',now)).workspace.tasks[0];assert.equal(current.notes,'Owner accepted exact contextual suggestion');assert.deepEqual({...current,notes:f.workspace.tasks[0].notes,updatedAt:f.workspace.tasks[0].updatedAt},f.workspace.tasks[0]);
 const committed=snapshot();assert.equal((await executeWorkspaceCommand('owner',input,deps)).status,'replayed');assert.deepEqual(snapshot(),committed);assert.equal(sqlite.prepare('SELECT state FROM source_proposals').get()!.state,'accepted');assert.deepEqual(sqlite.prepare('SELECT * FROM source_observations').all(),before.source_observations);
 }finally{sqlite.close();}
});
test('command JSON cannot hide prototype or lifecycle edits in owner-selected values',async()=>{
 const f=await fixture();await f.proposal();
 const command=JSON.parse('{"type":"sources.proposal.decide","id":"proposal","expectedRowRevision":1,"decision":"accept","reason":"Review","selectedFields":["notes"],"editedValues":{"__proto__":{"approved":true},"notes":"Safe text"}}');
 assert.equal(sourceCommandSchema.safeParse(command).success,false);await assert.rejects(f.prepare(command));
 await assert.rejects(f.prepare({type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'accept',reason:'Review',selectedFields:['notes'],editedValues:{notes:{status:'done'}}}));
});
test('invalid unknown archive history fails closed instead of inventing lifecycle facts during a safe edit',async()=>{
 const f=await fixture();f.workspace.tasks[0].status='archived';f.workspace.tasks[0].completedAt=null;f.workspace.tasks[0].archivedFromStatus=null;f.workspace.tasks[0].weekly=false;f.workspace.tasks[0].weeklyWeek=null;await f.proposal();
 const before=structuredClone(f.workspace.tasks[0]);await assert.rejects(f.prepare({type:'sources.proposal.decide',id:'proposal',expectedRowRevision:1,decision:'accept',reason:'Edit only the reviewed context',selectedFields:['notes']}),/previous status/);assert.deepEqual(f.workspace.tasks[0],before);assert.equal(f.workspace.tasks[0].completedAt,null);assert.equal(f.workspace.tasks[0].archivedFromStatus,null);assert.equal(f.workspace.tasks[0].weekly,false);
});
test('manual import hashes bind only selected interactive document/conversation refresh input',async()=>{
 const f=await fixture();f.state.paused=false;const command={type:'sources.refresh.request',id:f.target.id,expectedRowRevision:1,manualImportHash:'d'.repeat(64)};await assert.rejects(f.prepare(command),/selected manual source/);
 const connection={...f.connection,provider:'documents' as const},target={...f.target,kind:'document' as const};await f.put('source_connections',connection);await f.put('source_targets',target);f.state.configurationHash=await sourceConfigurationHash(connection,target);
 const plan=await f.prepare(command);assert.deepEqual(plan.jobs[0].payload,{sourceId:target.id,configurationHash:f.state.configurationHash,manualImportHash:'d'.repeat(64)});assert.equal(plan.integrationJobs![0].intentId,plan.jobs[0].id);
 assert.equal(sourceCommandSchema.safeParse({...command,manualImportHash:'not-a-digest'}).success,false);
 await f.put('source_connections',{...connection,accessMode:'unattended'});f.state.configurationHash=await sourceConfigurationHash({...connection,accessMode:'unattended'},target);await assert.rejects(f.prepare(command),/selected manual source/);
});
