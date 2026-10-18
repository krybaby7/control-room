import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EXECUTION_LIMITS,parseJobSpec,jobSpecSha256,defaultExecutionPolicy,parseExecutionPolicy,executionPolicySha256,capabilitySha256,parseCapability,validateRelativePath,resolveAllowedPath,validateJobDependencyGraph,checkExecutionAdmission} from '../src/execution-policy.mjs';
const NOW='2026-10-18T12:00:00.000Z',hash='a'.repeat(64),base='b'.repeat(40);
/** All identities and native-context labels are synthetic compatibility inputs.
 * The pure checker issues no authenticated grant and launches no runtime. */
function fixture(){
 const runtime={version:'1.0.0-fixture',sourceCommit:'1'.repeat(40),packageSha256:'2'.repeat(64),toolPolicy:'native-sandbox',executableSha256:'3'.repeat(64),executableVersion:'1.0.0-fixture',toolPolicySha256:'4'.repeat(64)};
 const policy={schemaVersion:1,enabled:true,maxConcurrent:1,maxJobs:1,maxBatchSeconds:60,maxTimeoutSeconds:60,maxOutputBytesLimit:4096,operations:['project.inspect'],models:[{id:'exact-fixture-model',efforts:['medium']}],repositories:{fixture:{root:'C:\\synthetic\\repository',allowedPaths:['src'],protectedPaths:['src/private','.env'],operations:['project.inspect'],baseCommits:[base]}},runtime,provider:'codex',modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true};
 const spec={schemaVersion:1,operation:'project.inspect',projectId:'project-fixture',taskId:'task-fixture',baseWorkspaceRevision:7,taskSnapshotSha256:hash,repositoryKey:'fixture',baseCommit:base,inputArtifactIds:['input-fixture'],requestedModel:'exact-fixture-model',effort:'medium',timeoutSeconds:60,outputBytesLimit:4096,dependsOnJobIds:[]};
 const capability={schemaVersion:1,deviceId:'device-fixture',configurationSha256:executionPolicySha256(policy),runtime,operations:['project.inspect'],models:[{id:'exact-fixture-model',efforts:['medium']}],repositoryKeys:['fixture'],observedAt:NOW,expiresAt:'2026-10-18T12:05:00.000Z',maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:60,maxOutputBytesLimit:4096,provider:'codex',allowedPathsSha256ByRepositoryKey:{fixture:createHash('sha256').update(JSON.stringify(['src'])).digest('hex')},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true};
 const approval={id:'approval-fixture',jobId:'job-fixture',deviceId:capability.deviceId,specSha256:jobSpecSha256(spec),capabilitySha256:capabilitySha256(capability),configurationSha256:executionPolicySha256(policy),taskSnapshotSha256:hash,approvedAt:NOW,expiresAt:'2026-10-19T12:00:00.000Z',revokedAt:null,attempts:1,budget:{jobs:1,timeoutSeconds:60},origin:'native-owner'};
 const context={jobId:'job-fixture',deviceId:capability.deviceId,ownerKey:'owner-fixture',projectId:spec.projectId,taskId:spec.taskId,taskSnapshotSha256:hash,repositoryKey:'fixture',baseCommit:base,executionEpoch:3,approvalEpoch:3,jobStatus:'queued',activeAttempts:0,approvalConsumed:false,cancelRequested:false,localDisabled:false,usedJobs:0,usedRuntimeSeconds:0,artifacts:[{id:'input-fixture',ownerKey:'owner-fixture',sha256:'c'.repeat(64),bytes:128,immutable:true}],source:'native-authorized'};
 const dependencies=[{id:context.jobId,ownerKey:context.ownerKey,dependsOnJobIds:[],status:'queued'}];
 return {spec,specSha256:jobSpecSha256(spec),policy,capability,approval,context,dependencies,now:NOW};
}
const denied=(input,reason)=>{const result=checkExecutionAdmission(input);assert.equal(result.allowed,false);assert.ok(result.reasons.includes(reason),JSON.stringify(result));assert.equal(result.authority,'none');};
test('default local execution is disabled with no operations/models/repositories or batch grant',()=>{
 const policy=defaultExecutionPolicy();assert.equal(policy.enabled,false);assert.equal(policy.maxConcurrent,1);assert.equal(policy.maxJobs,0);assert.deepEqual(policy.operations,[]);assert.deepEqual(policy.models,[]);assert.deepEqual(policy.repositories,{});assert.equal(policy.runtime,null);assert.deepEqual(parseExecutionPolicy(policy),policy);
 const f=fixture();denied({...f,policy},'local_execution_disabled');
});
test('exact immutable spec hash ignores object insertion order and invalidates every changed field without model fallback',()=>{
 const f=fixture(),reordered=Object.fromEntries(Object.entries(f.spec).reverse());assert.equal(jobSpecSha256(reordered),f.specSha256);assert.equal(checkExecutionAdmission(f).allowed,true);assert.equal(checkExecutionAdmission(f).authority,'none');
 const changes={operation:'project.propose-patch',projectId:'project-two',taskId:'task-two',baseWorkspaceRevision:8,taskSnapshotSha256:'d'.repeat(64),repositoryKey:'other',baseCommit:'e'.repeat(40),inputArtifactIds:[],requestedModel:'another-exact-model',effort:'high',timeoutSeconds:59,outputBytesLimit:4095,dependsOnJobIds:['earlier-job']};
 for(const [key,value]of Object.entries(changes)){const spec={...f.spec,[key]:value};assert.notEqual(jobSpecSha256(spec),f.specSha256,key);if(key!=='dependsOnJobIds')denied({...f,spec},'spec_identity_changed');}
 const two={...f.spec,inputArtifactIds:['artifact-a','artifact-b']};assert.notEqual(jobSpecSha256(two),jobSpecSha256({...two,inputArtifactIds:[...two.inputArtifactIds].reverse()}));
});
test('closed task spec rejects executable/env/provider URL authority, duplicates, unknown versions and all bounds',()=>{
 const f=fixture();for(const patch of [{schemaVersion:2},{operation:'shell.exec'},{command:'echo unsafe'},{args:[]},{env:{}},{providerUrl:'https://example.invalid'},{repositoryKey:'../outside'},{baseCommit:'main'},{baseCommit:'A'.repeat(40)},{requestedModel:'auto/model'},{effort:'auto'},{timeoutSeconds:29},{timeoutSeconds:601},{timeoutSeconds:30.5},{outputBytesLimit:0},{outputBytesLimit:2097153},{inputArtifactIds:Array(9).fill('one')},{inputArtifactIds:['same','same']},{dependsOnJobIds:['same','same']},{baseWorkspaceRevision:0},{taskSnapshotSha256:'bad'}])assert.throws(()=>parseJobSpec({...f.spec,...patch}),JSON.stringify(patch));
 assert.throws(()=>parseExecutionPolicy({...f.policy,maxConcurrent:2}));assert.throws(()=>parseExecutionPolicy({...f.policy,executable:'anything'}));
});
test('exact task/source/model/effort/runtime/config/capability identities gate compatibility',()=>{
 for(const [field,value,reason]of [['taskSnapshotSha256','f'.repeat(64),'task_snapshot_changed'],['taskId','another-task','task_snapshot_changed'],['projectId','another-project','task_snapshot_changed'],['baseCommit','e'.repeat(40),'source_identity_changed'],['repositoryKey','other','source_identity_changed'],['deviceId','other-device','job_or_device_identity_changed']]){const f=fixture();denied({...f,context:{...f.context,[field]:value}},reason);}
 const f=fixture();denied({...f,policy:{...f.policy,runtime:{...f.policy.runtime,toolPolicy:'another-sandbox'}}},'runtime_or_tool_policy_changed');denied({...f,capability:{...f.capability,configurationSha256:'f'.repeat(64)}},'configuration_identity_changed');
 denied({...f,capability:{...f.capability,models:[{id:'different-model',efforts:['medium']}]}},'exact_model_unavailable');denied({...f,capability:{...f.capability,models:[{id:f.spec.requestedModel,efforts:['low']}]}},'effort_unavailable');denied({...f,capability:{...f.capability,operations:[]}},'operation_not_enabled');denied({...f,policy:{...f.policy,repositories:{fixture:{...f.policy.repositories.fixture,baseCommits:['d'.repeat(40)]}}}},'repository_not_registered');
});
test('approval lifetime is at most24h, capability at most5m; future, expired, revoked and epoch changes block',()=>{
 const f=fixture();for(const approval of [{...f.approval,expiresAt:'2026-10-19T12:00:00.001Z'},{...f.approval,approvedAt:'2026-02-30T12:00:00.000Z'}])assert.throws(()=>checkExecutionAdmission({...f,approval}));
 for(const patch of [{approvedAt:'2026-10-18T12:00:01.000Z',expiresAt:'2026-10-18T13:00:00.000Z'},{approvedAt:'2026-10-17T12:00:00.000Z',expiresAt:NOW},{revokedAt:NOW}])denied({...f,approval:{...f.approval,...patch}},'approval_unavailable');
 assert.throws(()=>parseCapability({...f.capability,expiresAt:'2026-10-18T12:05:00.001Z'}));
 denied({...f,now:'2026-10-18T12:05:00.000Z'},'capability_stale');
 denied({...f,capability:{...f.capability,observedAt:'2026-10-18T12:00:01.000Z',expiresAt:'2026-10-18T12:05:01.000Z'}},'capability_stale');
 denied({...f,context:{...f.context,executionEpoch:4}},'epoch_changed');
});
test('cancel/local disable/used approval/active attempt and historical claims never become launch or cancellation evidence',()=>{
 const f=fixture();for(const [patch,reason]of [[{cancelRequested:true},'cancel_requested'],[{localDisabled:true},'local_execution_disabled'],[{approvalConsumed:true},'attempt_not_admissible'],[{activeAttempts:1},'attempt_not_admissible'],[{jobStatus:'reconcile_required'},'attempt_not_admissible'],[{source:'historical-import'},'historical_context_not_authority']])denied({...f,context:{...f.context,...patch}},reason);
 denied({...f,approval:{...f.approval,origin:'historical-import'}},'historical_context_not_authority');denied({...f,capability:{...f.capability,availableSlots:0}},'attempt_not_admissible');
 assert.throws(()=>checkExecutionAdmission({...f,context:{...f.context,ownerOverride:'other'}}));
 // Native-looking labels are only caller inputs. Even a compatible verdict is
 // explicitly authority:none, never a grant/lease/confirmed process outcome.
 assert.deepEqual(Object.keys(checkExecutionAdmission(f)).sort(),['allowed','authority','reasons','specSha256']);
});
test('finite budget and exact owner immutable artifact inputs are enforced',()=>{
 const f=fixture();for(const patch of [{usedJobs:1},{usedRuntimeSeconds:1}])denied({...f,context:{...f.context,...patch}},'finite_budget_exceeded');
 denied({...f,approval:{...f.approval,budget:{jobs:1,timeoutSeconds:59}}},'finite_budget_exceeded');
 for(const artifacts of [[],[{...f.context.artifacts[0],ownerKey:'other-owner'}],[{...f.context.artifacts[0],immutable:false}]])denied({...f,context:{...f.context,artifacts}},'immutable_input_unavailable');
 assert.throws(()=>checkExecutionAdmission({...f,context:{...f.context,artifacts:[f.context.artifacts[0],f.context.artifacts[0]]}}),error=>error.code==='duplicate_value');
 const spec={...f.spec,inputArtifactIds:['input-fixture','second']},artifacts=[{...f.context.artifacts[0],bytes:32768},{...f.context.artifacts[0],id:'second',bytes:1}],changed={...f,spec,specSha256:jobSpecSha256(spec),approval:{...f.approval,specSha256:jobSpecSha256(spec)},context:{...f.context,artifacts}};denied(changed,'immutable_input_unavailable');
});
test('bounded dependency DAG rejects self/cycle/missing/foreign and requires exact successful dependency records',()=>{
 const f=fixture(),owner=f.context.ownerKey,row=(id,dependsOnJobIds=[],status='succeeded')=>({id,ownerKey:owner,dependsOnJobIds,status}),valid=[row('job-fixture',['before'],'queued'),row('before')];
 assert.deepEqual(validateJobDependencyGraph('job-fixture',valid,owner),valid);
 for(const records of [[row('job-fixture',['job-fixture'])],[row('job-fixture',['missing'])],[row('job-fixture',['before']),row('before',['job-fixture'])],[row('job-fixture'),{...row('before'),ownerKey:'foreign'}],[row('job-fixture'),row('job-fixture')],Array.from({length:257},(_,i)=>row(i?'extra-'+i:'job-fixture'))])assert.throws(()=>validateJobDependencyGraph('job-fixture',records,owner));
 const spec={...f.spec,dependsOnJobIds:['before']},input={...f,spec,specSha256:jobSpecSha256(spec),approval:{...f.approval,specSha256:jobSpecSha256(spec)},dependencies:valid};assert.equal(checkExecutionAdmission(input).allowed,true);
 denied({...input,dependencies:[valid[0],{...valid[1],status:'cancelled'}]},'dependency_not_succeeded');denied({...f,dependencies:valid},'dependency_identity_changed');
});
test('Windows/POSIX relative paths reject root/traversal/ADS/reserved devices/globs/protected ancestors',()=>{
 assert.equal(validateRelativePath('src\\folder\\file.md'),'src/folder/file.md');
 for(const value of ['','.', '..','src/../file','src//file','/root','C:\\root','\\\\host\\share','src/file:stream','src/*.md','src/[ab].md','src/%2e%2e/file','src/file.','src/file ','src/CON.txt','src/CONIN$','src/COM¹.txt','src/AUX','src/LPT1/file','src/.git/config','src/.ENV.local','src/credentials.json','src/.control-room-bridge/data','src/\u0000bad'])assert.throws(()=>validateRelativePath(value),value);
 for(const value of ['C:relative','\\\\host\\share','\\\\?\\C:\\repo','C:\\','/','//network/repo','C:\\repo\\..\\outside','/repo/../outside','/repo/.ssh','C:\\repo\\CON']){const f=fixture();assert.throws(()=>parseExecutionPolicy({...f.policy,repositories:{fixture:{...f.policy.repositories.fixture,root:value}}}),value);}
});
test('real temporary symlink escapes and protected ancestor aliases are refused; missing-leaf allowance remains bounded',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'synthetic-execution-policy-'));
 try{const repo=join(temp,'repo'),outside=join(temp,'outside');await mkdir(join(repo,'src','private'),{recursive:true});await mkdir(outside);await writeFile(join(repo,'src','ok.md'),'synthetic only');await writeFile(join(repo,'src','private','key.md'),'synthetic only');await writeFile(join(outside,'external.md'),'synthetic only');
 const registration={root:await realpath(repo),allowedPaths:['src'],protectedPaths:['src/private'],operations:['project.inspect'],baseCommits:[base]};
 assert.equal(await resolveAllowedPath(registration,'src/ok.md'),await realpath(join(repo,'src','ok.md')));
 await assert.rejects(resolveAllowedPath(registration,'src/private/key.md'));await assert.rejects(resolveAllowedPath(registration,'outside.md'));
 assert.equal(await resolveAllowedPath(registration,'src/new.md',{allowMissingLeaf:true}),join(repo,'src','new.md'));await assert.rejects(resolveAllowedPath(registration,'src/missing-parent/new.md',{allowMissingLeaf:true}));
 await t.test('actual temporary symlink or junction subcase',async sub=>{
  try{await symlink(outside,join(repo,'src','escape'),process.platform==='win32'?'junction':'dir');await symlink(join(repo,'src','private'),join(repo,'src','alias'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){sub.skip('Platform does not permit real symlink/junction creation; NOT RUN.');return;}throw error;}
  await assert.rejects(resolveAllowedPath(registration,'src/escape/external.md'),/path_escape/);await assert.rejects(resolveAllowedPath(registration,'src/alias/key.md'),/path_outside_allowed_scope/);
 });
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('Windows canonical case folding is local path comparison only; junction-like outside root is rejected',async()=>{
 const f=fixture(),repo=f.policy.repositories.fixture,root='C:\\synthetic\\repository',good='C:\\synthetic\\repository\\SRC\\file.md';
 assert.equal(await resolveAllowedPath(repo,'SRC/file.md',{realpath:async value=>value===root?root.toUpperCase():good}),good);
 await assert.rejects(resolveAllowedPath(repo,'src/file.md',{realpath:async value=>value===root?root:'D:\\outside\\file.md'}),/path_escape/);
 await assert.rejects(resolveAllowedPath(repo,'SRC/PRIVATE/file.md',{realpath:async value=>value}));
 await assert.rejects(resolveAllowedPath(repo,'src/file.md',{realpath:async value=>value===root?'C:\\junction-target':value}),/repository_root_not_canonical/);
});

test('full executable/tool/provider/allowed-path/identity-policy pins invalidate the canonical capability and approval',()=>{
 const f=fixture();for(const field of ['executableSha256','toolPolicySha256','executableVersion']){const value=field.endsWith('Sha256')?'f'.repeat(64):'other-version';denied({...f,capability:{...f.capability,runtime:{...f.capability.runtime,[field]:value}}},'runtime_or_tool_policy_changed');}
 denied({...f,capability:{...f.capability,provider:'claude'}},'provider_identity_changed');
 denied({...f,capability:{...f.capability,allowedPathsSha256ByRepositoryKey:{fixture:'f'.repeat(64)}}},'allowed_path_identity_changed');
 denied({...f,capability:{...f.capability,modelIdentityPolicy:'allow-unverified'}},'subscription_or_identity_policy_changed');
 for(const patch of [{subscriptionOnly:false},{extraUsageOffAttested:false},{allowedPathsSha256ByRepositoryKey:{}},{allowedPathsSha256ByRepositoryKey:{fixture:'f'.repeat(64),other:'f'.repeat(64)}}])assert.throws(()=>parseCapability({...f.capability,...patch}));
 for(const key of ['provider','allowedPathsSha256ByRepositoryKey','modelIdentityPolicy','subscriptionOnly','extraUsageOffAttested']){const raw={...f.capability};delete raw[key];assert.throws(()=>parseCapability(raw));}
});

test('dependency history graph reaches256 without expanding the twelve-job finite batch limit',()=>{
 const owner='owner-fixture',rows=Array.from({length:256},(_,i)=>({id:i?'history-'+i:'job-fixture',ownerKey:owner,dependsOnJobIds:i<255?['history-'+(i+1)]:[],status:i?'succeeded':'queued'}));assert.equal(validateJobDependencyGraph('job-fixture',rows,owner).length,256);assert.equal(EXECUTION_LIMITS.jobs,12);assert.equal(EXECUTION_LIMITS.graphNodes,256);assert.throws(()=>validateJobDependencyGraph('job-fixture',[...rows,{id:'history-overflow',ownerKey:owner,dependsOnJobIds:[],status:'succeeded'}],owner));const foreign=structuredClone(rows);foreign[255].ownerKey='foreign';assert.throws(()=>validateJobDependencyGraph('job-fixture',foreign,owner));const cycle=structuredClone(rows);cycle[255].dependsOnJobIds=['job-fixture'];assert.throws(()=>validateJobDependencyGraph('job-fixture',cycle,owner));
});
