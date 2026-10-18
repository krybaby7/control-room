import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {newReleaseStatus,releaseStatusSchema,releaseAcceptance,verifyGitHubArtifact,verifyGitHubCheck,RELEASE_CHECKS} from '../lib/release-verification.ts';

const SOURCE='a'.repeat(40),DIGEST='b'.repeat(64),NOW='2026-10-18T12:00:00.000Z';
/** Synthetic API-shaped data tests validation; these objects are not release evidence. */
function fixture(){
 const run={id:12345,head_sha:SOURCE,status:'completed',conclusion:'success',run_attempt:2,html_url:'https://github.com/krybaby7/control-room/actions/runs/12345',repository:{full_name:'krybaby7/control-room'}};
 const job={id:67890,run_id:run.id,head_sha:SOURCE,status:'completed',conclusion:'success',html_url:run.html_url+'/job/67890',steps:[{number:3,name:'Run npm test',status:'completed',conclusion:'success',completed_at:NOW}]};
 const artifact={id:24680,name:'control-room-candidate-'+SOURCE,size_in_bytes:1024,expired:false,digest:'sha256:'+DIGEST,workflow_run:{id:run.id,head_sha:SOURCE}};
 return {checkId:'node-tests' as const,sourceCommit:SOURCE,run,job,artifact,stepNumber:3,now:NOW,attemptJobIds:[job.id]};
}
test('new candidate is incomplete and every required gate appears once',()=>{
 const value=newReleaseStatus('synthetic-candidate');
 assert.equal(value.sourceCommit,null);assert.equal(value.artifactSha256,null);
 assert.equal(value.phases.hostedAcceptance,'owner-dependent');
 assert.deepEqual(value.checks.map(check=>check.id),RELEASE_CHECKS.map(check=>check.id));
 assert.equal(releaseAcceptance(value).accepted,false);assert.ok(releaseAcceptance(value).blocked.includes('oversized-owner-recovery'));
 assert.throws(()=>releaseStatusSchema.parse({...value,checks:value.checks.slice(1)}));
 assert.throws(()=>releaseStatusSchema.parse({...value,checks:[...value.checks.slice(1),value.checks[1]]}));
 assert.throws(()=>releaseStatusSchema.parse({...value,unknown:true}));
});
test('passed requires exact source, candidate artifact, timestamp and matching successful gate step',()=>{
 const input=fixture(),proof=verifyGitHubCheck(input),value=newReleaseStatus('synthetic-candidate');
 value.sourceCommit=SOURCE;value.artifact=verifyGitHubArtifact(input);value.artifactSha256=DIGEST;
 Object.assign(value.checks[0],{status:'passed',observedAt:proof.observedAt,evidencePath:proof.evidence.jobUrl,evidence:proof.evidence});
 assert.equal(releaseStatusSchema.parse(value).checks[0].status,'passed');
 for(const mutation of [
  {sourceCommit:null},{artifactSha256:'c'.repeat(64)},{artifact:{...value.artifact,name:'windows-bridge-package'}},
  {checks:value.checks.map((check,index)=>index?check:{...check,observedAt:null})},
  {checks:value.checks.map((check,index)=>index?check:{...check,evidence:null})},
  {checks:value.checks.map((check,index)=>index?check:{...check,evidence:{...proof.evidence,sourceCommit:'c'.repeat(40)}})},
 ])assert.throws(()=>releaseStatusSchema.parse({...value,...mutation}));
 assert.equal(releaseAcceptance(value).accepted,false);
});
test('completed run, exact repository/source/job/attempt and actual nonexpired digest are mandatory',()=>{
 const good=fixture();assert.equal(verifyGitHubCheck(good).evidence.artifact.sha256,DIGEST);
 for(const alter of [
  (f:ReturnType<typeof fixture>)=>{f.run.status='in_progress';},
  (f:ReturnType<typeof fixture>)=>{f.run.conclusion='failure';},
  (f:ReturnType<typeof fixture>)=>{f.run.repository.full_name='other/repository';},
  (f:ReturnType<typeof fixture>)=>{f.run.head_sha='c'.repeat(40);},
  (f:ReturnType<typeof fixture>)=>{f.job.head_sha='c'.repeat(40);},
  (f:ReturnType<typeof fixture>)=>{f.job.run_id++;},
  (f:ReturnType<typeof fixture>)=>{f.attemptJobIds=[];},
  (f:ReturnType<typeof fixture>)=>{f.job.html_url+='?forged=true';},
  (f:ReturnType<typeof fixture>)=>{f.artifact.workflow_run.id++;},
  (f:ReturnType<typeof fixture>)=>{f.artifact.workflow_run.head_sha='c'.repeat(40);},
  (f:ReturnType<typeof fixture>)=>{f.artifact.expired=true;},
  (f:ReturnType<typeof fixture>)=>{f.artifact.digest='';},
 ]){const input=fixture();alter(input);assert.throws(()=>verifyGitHubCheck(input));}
});
test('step failure/skipped/wrong command/missing date/future date never becomes success',()=>{
 for(const change of [{conclusion:'failure'},{conclusion:'skipped'},{name:'Run echo success'},{completed_at:null},{completed_at:'2026-10-18T13:00:00.000Z'}]){
  const input=fixture();Object.assign(input.job.steps[0],change);assert.throws(()=>verifyGitHubCheck(input));
 }
 assert.throws(()=>verifyGitHubCheck({...fixture(),stepNumber:99}));
 assert.throws(()=>verifyGitHubCheck({...fixture(),checkId:'hosted-private-acceptance'}),/external observed evidence/);
 assert.throws(()=>verifyGitHubCheck({...fixture(),checkId:'oversized-owner-recovery'}),/external observed evidence/);
});
test('missing external gates cannot be waived or implied by local verification',()=>{
 const value=newReleaseStatus('synthetic-candidate');
 value.checks[0].status='not-applicable';value.checks[0].limitation='Disabled';value.checks[0].disabledScope='everything';
 assert.throws(()=>releaseStatusSchema.parse(value));
 const incomplete=newReleaseStatus('synthetic-candidate');incomplete.phases.localVerification='passed';
 assert.throws(()=>releaseStatusSchema.parse(incomplete));
 incomplete.phases.localVerification='not-run';incomplete.phases.hostedAcceptance='passed';
 assert.throws(()=>releaseStatusSchema.parse(incomplete));
});
test('JSON schema lists the same closed required gate set and rejects unknown top-level fields',async()=>{
 const schema=JSON.parse(await readFile(new URL('../docs/releases/release-status.schema.json',import.meta.url),'utf8'));
 assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.checks.minItems,RELEASE_CHECKS.length);
 assert.deepEqual(schema.properties.checks.items.properties.id.enum,RELEASE_CHECKS.map(check=>check.id));
 assert.deepEqual(schema.properties.checks.allOf.map((gate:{contains:{properties:{id:{const:string}}}})=>gate.contains.properties.id.const),RELEASE_CHECKS.map(check=>check.id));
 assert.equal(schema.properties.checks.items.additionalProperties,false);
});
test('recorder creates only blocked initial evidence, refuses overwrite/waiver and cannot pass without a built artifact',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-release-recorder-'));
 const script=fileURLToPath(new URL('../scripts/record-release-check.mjs',import.meta.url));
 const run=(args:string[])=>spawnSync(process.execPath,['--experimental-strip-types',script,...args],{cwd:directory,encoding:'utf8',timeout:20000,env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:''}});
 try{
  assert.equal(run(['init','--candidate','synthetic-candidate']).status,0);
  const status=JSON.parse(await readFile(join(directory,'docs/releases/synthetic-candidate/status.json'),'utf8'));
  assert.equal(releaseAcceptance(status).accepted,false);
  assert.equal(run(['verify','--candidate','synthetic-candidate']).status,1);
  assert.equal(run(['init','--candidate','synthetic-candidate']).status,1);
  assert.equal(run(['record','--candidate','synthetic-candidate','--check','node-tests','--status','passed','--run','12345','--job','67890','--artifact','24680','--step','3']).status,1);
  assert.equal(run(['record','--candidate','synthetic-candidate','--check','hosted-private-acceptance','--status','owner-dependent','--reason','Requires actual owner gateway authentication.']).status,0);
  assert.equal(run(['record','--candidate','synthetic-candidate','--check','node-tests','--status','not-applicable','--reason','Pretend disabled']).status,1);
  assert.equal(run(['init','--candidate','../../outside']).status,1);
  const after=JSON.parse(await readFile(join(directory,'docs/releases/synthetic-candidate/status.json'),'utf8'));assert.equal(after.checks[0].status,'not-run');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('portable runner rejects production targets before starting any fixture command',()=>{
 const script=fileURLToPath(new URL('../scripts/verify-release.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[script,'--target','production'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,1);assert.match(result.stderr,/Production identifiers, URLs and arbitrary commands are not accepted/);
});
