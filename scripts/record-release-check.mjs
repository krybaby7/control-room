// Records sanitized release evidence only. Does not publish, enable a capability, or touch owner data.
import {readFile,writeFile,rename,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {releaseStatusSchema,newReleaseStatus,releaseAcceptance,verifyGitHubArtifact,verifyGitHubCheck,verifyObservedAttestation,deriveReleasePhases,RELEASE_CHECKS,RELEASE_REPOSITORY} from '../lib/release-verification.ts';
const usage='Usage: node --experimental-strip-types scripts/record-release-check.mjs init --candidate NAME [--run ID --artifact ID] | bind --candidate NAME --run ID --artifact ID | record --candidate NAME --check ID --status STATUS [--run ID --job ID --artifact ID --step NUMBER | --reason TEXT] | observe --candidate NAME --attestation REPO_RELATIVE_JSON --sha256 EXPECTED_CANONICAL_SHA | verify --candidate NAME';
function args(argv){
 const [command,...rest]=argv;if(!['init','bind','record','observe','verify'].includes(command)||rest.length%2)throw new Error(usage);
 const options={};for(let i=0;i<rest.length;i+=2){const key=rest[i];if(!/^--[a-z]+$/.test(key)||Object.hasOwn(options,key))throw new Error('Unknown or duplicate argument.');options[key]=rest[i+1];}
 const allowed=command==='observe'?['--candidate','--attestation','--sha256']:command==='record'?['--candidate','--check','--status','--run','--job','--artifact','--step','--reason']:['init','bind'].includes(command)?['--candidate','--run','--artifact']:['--candidate'];
 if(Object.keys(options).some(key=>!allowed.includes(key))||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(options['--candidate']??''))throw new Error(usage);
 return {command,options};
}
const number=value=>{if(!/^[1-9][0-9]{0,15}$/.test(value??'')||!Number.isSafeInteger(Number(value)))throw new Error('A positive exact GitHub identifier is required.');return Number(value);};
const root=await realpath(process.cwd());
async function statusPath(candidate){
 const output=resolve(root,'docs/releases',candidate,'status.json');
 if(relative(root,output).startsWith('..'))throw new Error('Invalid output path.');
 let directory=root;
 for(const part of ['docs','releases',candidate]){
  directory=join(directory,part);await mkdir(directory,{recursive:true});const entry=await lstat(directory);if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error('Release output must use real repository directories.');
 }
 try{const entry=await lstat(output);if(!entry.isFile()||entry.isSymbolicLink())throw new Error('Release status must be a regular file.');}catch(error){if(error.code!=='ENOENT')throw error;}
 return output;
}
async function observedFile(value){
 if(typeof value!=='string'||!/^docs\/releases\/[a-z0-9-]+\/observations\/[a-z0-9-]+\.json$/.test(value))throw new Error('Use a reviewed repository observation JSON file.');
 const path=resolve(root,value);let current=root;
 for(const part of relative(root,path).split('/')){current=join(current,part);const entry=await lstat(current);if(entry.isSymbolicLink())throw new Error('Observation path must not contain symlinks.');}
 const stat=await lstat(path);if(!stat.isFile()||stat.size>65536)throw new Error('Observation must be a bounded regular file.');
 return {path,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path)))};
}
async function readStatus(path){const bytes=await readFile(path);if(bytes.length>1000000)throw new Error('Status file exceeds bound.');return releaseStatusSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
async function save(path,value){const text=JSON.stringify(releaseStatusSchema.parse(value),null,2)+'\n',temporary=path+'.'+crypto.randomUUID()+'.tmp';await writeFile(temporary,text,{flag:'wx',mode:0o600});await rename(temporary,path);}
function sourceCommit(){const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:10000}).trim();if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Exact Git source is unavailable.');return sha;}
async function github(path){
 const token=process.env.GH_TOKEN??process.env.GITHUB_TOKEN;if(!token)throw new Error('A read-scoped GitHub token is required to verify actual run/artifact evidence.');
 const response=await fetch('https://api.github.com/repos/'+RELEASE_REPOSITORY+path,{headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('GitHub evidence lookup failed ('+response.status+').');
 if(!response.body)throw new Error('GitHub evidence response has no body.');
 const reader=response.body.getReader(),parts=[];let total=0;try{for(;;){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;if(total>2000000){await reader.cancel();throw new Error('GitHub evidence response exceeds bound.');}parts.push(item.value);}}finally{reader.releaseLock();}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,total)));
}
async function completedRun(runId){return github('/actions/runs/'+runId);}
async function attemptJobs(run){
 const ids=[];for(let page=1;page<=10;page++){const response=await github('/actions/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs?per_page=100&page='+page);if(!Array.isArray(response.jobs)||response.jobs.length>100)throw new Error('Invalid run-attempt job list.');for(const job of response.jobs)ids.push(number(String(job.id)));if(response.jobs.length<100)return ids;}throw new Error('Run job pagination exceeds bound.');
}
try{
 const {command,options}=args(process.argv.slice(2)),candidate=options['--candidate'],path=await statusPath(candidate);
 if(command==='init'){
  try{await lstat(path);throw new Error('Candidate already exists; never overwrite evidence with init.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const status=newReleaseStatus(candidate);
  if(options['--run']||options['--artifact']){
   const source=sourceCommit(),run=await completedRun(number(options['--run'])),artifact=await github('/actions/artifacts/'+number(options['--artifact']));
   const verified=verifyGitHubArtifact({sourceCommit:source,run,artifact});if(verified.name!=='control-room-candidate-'+source)throw new Error('Artifact is not the exact named application candidate.');
   status.sourceCommit=source;status.artifact=verified;status.artifactSha256=verified.sha256;
  }
  await save(path,status);console.log(JSON.stringify({candidate,accepted:false,checks:status.checks.length})); 
 }else{
  const status=await readStatus(path);if(status.candidate!==candidate)throw new Error('Candidate identity differs.');
  if(command==='bind'){
   if(status.artifact!==null||status.sourceCommit!==null||status.checks.some(check=>check.status==='passed'))throw new Error('Bound candidate evidence is immutable; use a new candidate identity.');
   const source=sourceCommit(),run=await completedRun(number(options['--run'])),artifact=await github('/actions/artifacts/'+number(options['--artifact']));
   const verified=verifyGitHubArtifact({sourceCommit:source,run,artifact});if(verified.name!=='control-room-candidate-'+source)throw new Error('Artifact is not the exact named application candidate.');
   status.sourceCommit=source;status.artifact=verified;status.artifactSha256=verified.sha256;await save(path,status);console.log(JSON.stringify({candidate,sourceCommit:source,artifactSha256:verified.sha256,accepted:false}));
  }else if(command==='verify'){
   if(status.artifact){const run=await completedRun(status.artifact.runId),artifact=await github('/actions/artifacts/'+status.artifact.id);const actual=verifyGitHubArtifact({sourceCommit:status.sourceCommit,run,artifact});if(JSON.stringify(actual)!==JSON.stringify(status.artifact))throw new Error('Candidate artifact provenance changed.');}
   for(const check of status.checks.filter(check=>check.status==='passed')){const proof=check.evidence;
    if(proof.kind==='observed-attestation'){
     const file=await observedFile(check.evidencePath),actual=await verifyObservedAttestation({record:file.value,recordSha256:proof.recordSha256,candidate,sourceCommit:status.sourceCommit,artifact:status.artifact,now:new Date().toISOString()});
     if(JSON.stringify(actual.evidence)!==JSON.stringify(proof))throw new Error('Observed record changed.');continue;
    }
    const run=await completedRun(proof.runId),job=await github('/actions/jobs/'+proof.jobId),artifact=await github('/actions/artifacts/'+proof.artifact.id);const actual=verifyGitHubCheck({checkId:check.id,sourceCommit:status.sourceCommit,run,job,artifact,stepNumber:proof.stepNumber,now:new Date().toISOString(),attemptJobIds:await attemptJobs(run)});const expected={...proof,verifiedAt:actual.evidence.verifiedAt};if(JSON.stringify(actual.evidence)!==JSON.stringify(expected)||actual.observedAt!==check.observedAt)throw new Error('Recorded gate provenance changed.');}
   const result=releaseAcceptance(status);console.log(JSON.stringify({candidate,...result}));if(!result.accepted)process.exitCode=1;}
  else if(command==='observe'){
   if(!status.sourceCommit||!status.artifact||status.sourceCommit!==sourceCommit())throw new Error('Observation requires the exact bound candidate checkout.');
   const file=await observedFile(options['--attestation']),verified=await verifyObservedAttestation({record:file.value,recordSha256:options['--sha256'],candidate,sourceCommit:status.sourceCommit,artifact:status.artifact,now:new Date().toISOString()});
   const check=status.checks.find(check=>check.id===verified.evidence.record.checkId);
   Object.assign(check,{status:'passed',observedAt:verified.observedAt,evidencePath:options['--attestation'],evidence:verified.evidence,limitation:null,disabledScope:null});
   status.phases=deriveReleasePhases(status);await save(path,status);console.log(JSON.stringify({candidate,check:check.id,status:'passed',kind:'observed-attestation',accepted:releaseAcceptance(status).accepted}));
  }
  else{
   const id=options['--check'],spec=RELEASE_CHECKS.find(check=>check.id===id);if(!spec)throw new Error('Unknown required release gate.');
   const outcome=options['--status'];if(!['not-run','passed','failed','unavailable','owner-dependent'].includes(outcome))throw new Error('Invalid outcome; required gates cannot be disabled by a recorder.');
   const check=status.checks.find(check=>check.id===id),now=new Date().toISOString();
   if(outcome==='passed'){
    if(options['--reason'])throw new Error('Passed evidence cannot have an unresolved limitation.');
    if(!status.sourceCommit||!status.artifact||status.sourceCommit!==sourceCommit())throw new Error('Passed evidence requires the exact built candidate in this checkout.');
    const run=await completedRun(number(options['--run'])),job=await github('/actions/jobs/'+number(options['--job'])),artifact=await github('/actions/artifacts/'+number(options['--artifact']));
    const verified=verifyGitHubCheck({checkId:id,sourceCommit:status.sourceCommit,run,job,artifact,stepNumber:number(options['--step']),now,attemptJobIds:await attemptJobs(run)});
    Object.assign(check,{status:outcome,observedAt:verified.observedAt,evidencePath:verified.evidence.jobUrl+'#step:'+verified.evidence.stepNumber+':artifact:'+verified.evidence.artifact.id,evidence:verified.evidence,limitation:null,disabledScope:null});
   }else{
    if(['--run','--job','--artifact','--step'].some(key=>options[key]))throw new Error('Non-passed observations cannot carry a success run proof.');
    const reason=options['--reason']?.trim();if(outcome!=='not-run'&&!reason)throw new Error('An explicit limitation is required.');
    Object.assign(check,{status:outcome,observedAt:outcome==='not-run'?null:now,evidencePath:null,evidence:null,limitation:reason??null,disabledScope:null});
   }
   status.phases=deriveReleasePhases(status);
   await save(path,status);console.log(JSON.stringify({candidate,check:id,status:outcome,accepted:releaseAcceptance(status).accepted}));
  }
 }
}catch(error){console.error(error instanceof Error?error.message:'Release evidence rejected.');process.exitCode=1;}
