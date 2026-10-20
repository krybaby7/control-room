// Diagnostic orchestration only. Actual evidence is fetched and verified by the
// exact candidate's existing release recorder; this helper grants no acceptance.
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const MAIN=['node-tests','bridge-tests','typecheck','lint','build','d1-recovery','r2-recovery','chromium','r2-chromium'];
const CLOUD=[...MAIN,'performance','oversized-owner-recovery'];
const EXTERNAL=['hosted-private-acceptance','owner-device-acceptance'];
const REASONS={
 'hosted-private-acceptance':'Exact candidate private deployment, bindings, gateway authentication and owner-session acceptance have not been observed.',
 'owner-device-acceptance':'Actual owner-device workflows have not been observed for this exact candidate.',
};
const STATUS_COPY='final-cloud-ledger-status.json',REPORT='release-ledger-verification.json';
let phase='input',activeCheck=null,root;
class LedgerError extends Error{constructor(code){super(code);this.code=code;}}
const require=(condition,code)=>{if(!condition)throw new LedgerError(code);};
const keys=(value,expected)=>require(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\n')===[...expected].sort().join('\n'),'input-shape');
const identifier=value=>require(Number.isSafeInteger(value)&&value>0&&String(value).length<=16,'input-identifier');
const hash=value=>require(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),'input-digest');
function proof(value,main=false){
 keys(value,main?['runId','jobId','artifactId','steps']:['runId','jobId','artifactId','stepNumber']);
 for(const key of ['runId','jobId','artifactId'])identifier(value[key]);
 if(main){keys(value.steps,MAIN);for(const value of Object.values(value.steps)){identifier(value);require(value<=1000,'input-step');}}
 else{identifier(value.stepNumber);require(value.stepNumber<=1000,'input-step');}
}
function config(value){
 keys(value,['candidateCommit','candidateArtifact','candidate','main','performance','oversizedOwnerRecovery']);
 require(typeof value.candidateCommit==='string'&&/^[a-f0-9]{40}$/.test(value.candidateCommit)&&value.candidateCommit!=='0'.repeat(40),'input-source');
 require(typeof value.candidate==='string'&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.candidate),'input-candidate');
 keys(value.candidateArtifact,['id','zipSha256','workflowHead']);identifier(value.candidateArtifact.id);hash(value.candidateArtifact.zipSha256);
 require(value.candidateArtifact.workflowHead===value.candidateCommit,'input-artifact-source');
 proof(value.main,true);proof(value.performance);proof(value.oversizedOwnerRecovery);
 require(value.main.artifactId===value.candidateArtifact.id,'input-main-artifact');
 return value;
}
async function boundedFile(path,maxBytes){
 const stat=await lstat(path);require(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=maxBytes,'file-bound');
 const raw=await readFile(path);require(raw.length<=maxBytes,'file-bound');return raw;
}
function execute(program,args,timeout=180000){
 const child=spawnSync(program,args,{cwd:root,env:process.env,shell:false,encoding:'utf8',maxBuffer:256*1024,timeout});
 require(!child.error&&child.signal===null&&Number.isInteger(child.status),'subprocess-incomplete');
 // stdout/stderr remain captured. Never relay errors, API responses, credentials
 // or download URLs to logs, and never substitute helper-authored gate proofs.
 return child;
}
function recorder(args,expectedExit=0){
 const child=execute(process.execPath,['--experimental-strip-types',join(root,'scripts/record-release-check.mjs'),...args]);
 require(child.status===expectedExit,'strict-recorder-rejected');
 let value;try{value=JSON.parse(child.stdout.trim());}catch{throw new LedgerError('recorder-output');}
 require(value&&typeof value==='object'&&!Array.isArray(value),'recorder-output');return value;
}
const sha256=raw=>createHash('sha256').update(raw).digest('hex');
async function absent(path){try{await lstat(path);throw new LedgerError('output-exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
async function output(path,value){const raw=JSON.stringify(value,null,2)+'\n';require(Buffer.byteLength(raw)<=65536,'report-bound');await writeFile(path,raw,{flag:'wx',mode:0o600});}
async function main(){
 require(process.argv.length===3,'usage');require(Number(process.versions.node.split('.')[0])===24,'node-24-required');
 require(typeof process.env.GH_TOKEN==='string'&&process.env.GH_TOKEN.length>0,'github-token-required');
 root=await realpath(process.cwd());
 await absent(join(root,REPORT));await absent(join(root,STATUS_COPY));
 const inputRaw=await boundedFile(resolve(process.argv[2]),65536);let parsed;
 try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(inputRaw));}catch{throw new LedgerError('input-json');}
 const input=config(parsed);
 phase='source';
 const top=execute('git',['rev-parse','--show-toplevel'],10000);require(top.status===0&&await realpath(top.stdout.trim())===root,'candidate-root');
 const head=execute('git',['rev-parse','HEAD'],10000);require(head.status===0&&head.stdout.trim()===input.candidateCommit,'candidate-head');
 const diff=execute('git',['diff','--name-only','HEAD'],10000);require(diff.status===0&&diff.stdout.trim()==='','candidate-tracked-diff');
 const recorderFile=await boundedFile(join(root,'scripts/record-release-check.mjs'),100000);
 phase='bind';
 const bound=recorder(['init','--candidate',input.candidate,'--run',String(input.main.runId),'--artifact',String(input.candidateArtifact.id)]);
 require(bound.candidate===input.candidate&&bound.accepted===false,'recorder-bind-result');
 const statusPath=join(root,'docs/releases',input.candidate,'status.json');
 let status=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedFile(statusPath,1000000)));
 require(status.sourceCommit===input.candidateCommit&&status.artifact?.id===input.candidateArtifact.id&&status.artifact?.runId===input.main.runId&&status.artifactSha256===input.candidateArtifact.zipSha256&&status.artifact?.sha256===input.candidateArtifact.zipSha256,'candidate-artifact-pin');
 phase='cloud-gates';
 for(const id of CLOUD){
  activeCheck=id;const source=MAIN.includes(id)?input.main:id==='performance'?input.performance:input.oversizedOwnerRecovery;
  const step=MAIN.includes(id)?source.steps[id]:source.stepNumber;
  const result=recorder(['record','--candidate',input.candidate,'--check',id,'--status','passed','--run',String(source.runId),'--job',String(source.jobId),'--artifact',String(source.artifactId),'--step',String(step)]);
  require(result.candidate===input.candidate&&result.check===id&&result.status==='passed'&&result.accepted===false,'recorder-gate-result');
 }
 phase='external-blockers';
 for(const id of EXTERNAL){
  activeCheck=id;const result=recorder(['record','--candidate',input.candidate,'--check',id,'--status','owner-dependent','--reason',REASONS[id]]);
  require(result.candidate===input.candidate&&result.check===id&&result.status==='owner-dependent'&&result.accepted===false,'recorder-external-result');
 }
 activeCheck=null;phase='verify';
 const verified=recorder(['verify','--candidate',input.candidate],1);
 const statusRaw=await boundedFile(statusPath,1000000);status=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(statusRaw));
 require(status.candidate===input.candidate&&status.sourceCommit===input.candidateCommit&&Array.isArray(status.checks)&&status.checks.length===13,'status-identity');
 require(CLOUD.every(id=>status.checks.filter(check=>check.id===id&&check.status==='passed'&&check.evidence?.kind==='github-actions').length===1),'cloud-gates-incomplete');
 require(EXTERNAL.every(id=>status.checks.filter(check=>check.id===id&&check.status==='owner-dependent'&&check.evidence===null&&check.limitation===REASONS[id]).length===1),'external-status');
 require(status.phases.implementation==='in-progress'&&status.phases.localVerification==='passed'&&status.phases.hostedAcceptance==='owner-dependent','phase-status');
 const expected=[...EXTERNAL,'implementation','hostedAcceptance'].sort();
 require(verified.candidate===input.candidate&&verified.accepted===false&&Array.isArray(verified.blocked)&&verified.blocked.length===expected.length&&[...verified.blocked].sort().join('\n')===expected.join('\n'),'unexpected-release-blockers');
 const report={format:'control-room-final-cloud-ledger-diagnostic',version:1,status:'cloud-recorded-release-blocked',sourceCommit:input.candidateCommit,candidate:input.candidate,inputSha256:sha256(inputRaw),recorderSha256:sha256(recorderFile),statusSha256:sha256(statusRaw),candidateArtifact:status.artifact,
  cloudChecks:status.checks.filter(check=>CLOUD.includes(check.id)).map(check=>({id:check.id,status:check.status,observedAt:check.observedAt,runId:check.evidence.runId,runAttempt:check.evidence.runAttempt,jobId:check.evidence.jobId,stepNumber:check.evidence.stepNumber,artifactId:check.evidence.artifact.id,artifactSha256:check.evidence.artifact.sha256})),
  externalChecks:status.checks.filter(check=>EXTERNAL.includes(check.id)).map(check=>({id:check.id,status:check.status,limitation:check.limitation})),phases:status.phases,verification:{exitCode:1,...verified},releaseAccepted:false,deployed:false,providerExecution:false,ownerDeviceAcceptance:false};
 phase='output';await writeFile(join(root,STATUS_COPY),statusRaw,{flag:'wx',mode:0o600});await output(join(root,REPORT),report);
 console.log(JSON.stringify({status:report.status,candidate:input.candidate,releaseAccepted:false,blocked:verified.blocked}));
}
try{await main();}catch(error){
 const failure={format:'control-room-final-cloud-ledger-diagnostic',version:1,status:'failed',phase,check:activeCheck,reason:error instanceof LedgerError?error.code:'unexpected-helper-error',releaseAccepted:false,deployed:false,providerExecution:false,ownerDeviceAcceptance:false};
 if(root)try{await output(join(root,REPORT),failure);}catch{}
 console.error(JSON.stringify(failure));process.exitCode=1;
}
