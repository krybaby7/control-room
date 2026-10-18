// Portable, sequential verification of the exact checkout against disposable fixtures only.
// This records process results, not hosted acceptance or a release artifact.
import {spawn,execFileSync} from 'node:child_process';
import {writeFile,mkdir,lstat,rename} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {performance} from 'node:perf_hooks';
const commands=[
 ['node-tests',['test']],['bridge-tests',['run','test:bridge']],['typecheck',['run','typecheck']],['lint',['run','lint']],['build',['run','build']],
 ['generation-d1',['run','test:generation-d1']],['d1-recovery',['run','test:workspace-d1']],['sources-d1',['run','test:sources-d1']],
 ['reviews-migration-d1',['run','test:reviews-migration-d1']],['reviews-d1',['run','test:reviews-d1']],['scheduled-backup-d1',['run','test:scheduled-backup-d1']],
 ['scheduled-source-d1',['run','test:scheduled-source-d1']],['runtime-d1',['run','test:runtime-d1']],['agents-d1',['exec','--','node','--experimental-strip-types','scripts/test-agents-d1.mjs']],['segmented-recovery',['exec','--','node','--experimental-strip-types','scripts/test-recovery-segments-d1.mjs']],['worker-fixture',['run','test:fixture']],
 ['attachment-r2',['run','test:attachments-r2']],['r2-recovery',['run','test:attachment-recovery-r2']],['chromium',['run','test:e2e']],
 ['r2-chromium',['run','test:e2e:r2']],['attachment-http',['run','test:attachments-http']]
];
const perCommandMs=10*60*1000;
let active=null,interrupted=false;
function stopActive(signal){if(!active)return;try{process.kill(-active.pid,signal);}catch{active.kill(signal);}}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=true;stopActive(signal);});
async function run(args){
 const started=performance.now();return new Promise(resolveResult=>{
  let timeout=false,settled=false;
  const child=spawn(process.platform==='win32'?'npm.cmd':'npm',args,{stdio:'inherit',env:{...process.env,CONTROL_ROOM_SOURCE_COMMIT:sourceCommit},shell:false,detached:true});active=child;
  const timer=setTimeout(()=>{timeout=true;stopActive('SIGTERM');},perCommandMs);
  const hard=setTimeout(()=>{stopActive('SIGKILL');},perCommandMs+5000);
  const finish=(exitCode,signal,error)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(hard);active=null;resolveResult({exitCode,signal,timeout,error,durationMs:Math.round(performance.now()-started)});};
  child.on('error',()=>finish(null,null,'process-start-failed'));child.on('close',(code,signal)=>finish(code,signal,null));
 });
}
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--target'||args[1]!=='local-fixture')throw new Error('Use --target local-fixture. Production identifiers, URLs and arbitrary commands are not accepted.');
if(process.platform==='win32')throw new Error('The release fixture runner currently supports the configured Unix cloud runtime; Windows device acceptance is separate.');
if(Number(process.versions.node.split('.')[0])!==24)throw new Error('Release verification requires Node 24.');
const root=process.cwd(),sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:10000}).trim();
if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw new Error('Exact Git source is required.');
if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',timeout:10000}).trim())throw new Error('Start from a clean checkout; dirty source cannot be verified as the candidate.');
const directory=resolve(root,'release/verification');if(relative(root,directory).startsWith('..'))throw new Error('Invalid report directory.');
// Do not follow a pre-existing output symlink.
for(const path of [resolve(root,'release'),directory]){try{const entry=await lstat(path);if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('Verification output must use a real directory.');}catch(error){if(error.code!=='ENOENT')throw error;}await mkdir(path,{recursive:true});}
const report={format:'control-room-portable-verification',version:1,sourceCommit,artifactSha256:null,environment:{node:process.versions.node,platform:process.platform,arch:process.arch,target:'local-fixture'},ci:process.env.GITHUB_ACTIONS==='true'?{repository:process.env.GITHUB_REPOSITORY??null,runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null}:null,startedAt:new Date().toISOString(),completedAt:null,status:'running',checks:[],limitations:['This is fixture evidence only; hosted authentication, owner devices, performance budgets and complete oversized-owner recovery remain separate required gates.','Build output is not a packaged release artifact.']};
const path=resolve(directory,sourceCommit+'.json');
async function save(){const temporary=path+'.tmp';await writeFile(temporary,JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(temporary,path);}
await save();
for(const [id,args]of commands){
 if(interrupted)break;
 console.log('\nRelease fixture check: '+id);
 const result=await run(args),status=result.exitCode===0&&!result.signal&&!result.timeout&&!result.error?'passed':'failed';
 report.checks.push({id,command:['npm',...args],status,...result});await save();
 if(status==='failed')break;
}
const sourceChanged=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:10000}).trim()!==sourceCommit||Boolean(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',timeout:10000}).trim());
if(sourceChanged)report.limitations.push('Source changed during verification; results cannot attest to the initial commit.');
report.completedAt=new Date().toISOString();report.status=!sourceChanged&&!interrupted&&report.checks.length===commands.length&&report.checks.every(check=>check.status==='passed')?'passed':'failed';
await save();console.log(JSON.stringify({sourceCommit,status:report.status,completed:report.checks.length,required:commands.length,report:relative(root,path)}));if(report.status!=='passed')process.exitCode=1;
