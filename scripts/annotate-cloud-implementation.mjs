// Applies an explicit integrator's conditional CLOUD IMPLEMENTATION audit only.
// It cannot pass a gate, attest to a device, deploy, or change release validators.
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,lstat,realpath,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const CLOUD=['node-tests','bridge-tests','typecheck','lint','build','d1-recovery','r2-recovery','chromium','r2-chromium','performance','oversized-owner-recovery'];
const EXTERNAL=['hosted-private-acceptance','owner-device-acceptance'];
const NEGATIVE=['wrongOuterDigest','changedInnerArchiveWithRecomputedOuterDigest','changedWholeSourceAgainstGitTree','changedHelperInteriorPreservingMZWithRecomputedOuterDigest','tarMetadataDecompressionBound','unsupportedPaxExtension','duplicateDirectoryPath','absoluteDirectoryPath'];
const OUTPUT='annotated-cloud-implementation-status.json',REPORT='cloud-implementation-annotation.json';
let root,phase='input',restorePath=null,restoreRaw=null;
class AnnotationError extends Error{constructor(code){super(code);this.code=code;}}
const require=(condition,code)=>{if(!condition)throw new AnnotationError(code);};
const sha256=raw=>createHash('sha256').update(raw).digest('hex');
function keys(value,names){require(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\n')===[...names].sort().join('\n'),'input-shape');}
const digest=value=>require(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),'input-digest');
const commit=value=>require(typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40),'input-source');
function sameSet(value,expected){return Array.isArray(value)&&value.length===expected.length&&[...value].sort().join('\n')===[...expected].sort().join('\n');}
function execute(program,args,timeout=180000){
 const child=spawnSync(program,args,{cwd:root,env:process.env,shell:false,encoding:'utf8',maxBuffer:256*1024,timeout});
 require(!child.error&&child.signal===null&&Number.isInteger(child.status),'subprocess-incomplete');return child;
}
function git(args){const child=execute('git',args,10000);require(child.status===0,'candidate-git');return child.stdout.trim();}
function verify(candidate,expected){
 const child=execute(process.execPath,['--experimental-strip-types',join(root,'scripts/record-release-check.mjs'),'verify','--candidate',candidate]);
 require(child.status===1,'strict-verification-exit');let result;
 try{result=JSON.parse(child.stdout.trim());}catch{throw new AnnotationError('strict-verification-output');}
 require(result?.candidate===candidate&&result.accepted===false&&sameSet(result.blocked,expected),'strict-verification-blockers');return {exitCode:1,...result};
}
async function absent(path){try{await lstat(path);throw new AnnotationError('output-exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
async function file(path,limit){
 const stat=await lstat(path);require(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=limit,'file-bound');const raw=await readFile(path);require(raw.length<=limit,'file-bound');return raw;
}
function json(raw){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new AnnotationError('input-json');}}
async function atomicStatus(path,raw){const temporary=path+'.annotation-'+randomUUID()+'.tmp';await writeFile(temporary,raw,{flag:'wx',mode:0o600});await rename(temporary,path);}
async function report(value){const raw=JSON.stringify(value,null,2)+'\n';require(Buffer.byteLength(raw)<=65536,'report-bound');await writeFile(join(root,REPORT),raw,{flag:'wx',mode:0o600});}
async function main(){
 require(process.argv.length===3,'usage');require(Number(process.versions.node.split('.')[0])===24,'node-24-required');require(typeof process.env.GH_TOKEN==='string'&&process.env.GH_TOKEN.length>0,'github-token-required');
 root=await realpath(process.cwd());await absent(join(root,OUTPUT));await absent(join(root,REPORT));
 const parent=await realpath(resolve(root,'..')),inputRaw=await file(resolve(process.argv[2]),65536),input=json(inputRaw);
 keys(input,['candidateCommit','sourceTree','candidate','candidateArtifact','auditSha256','integritySha256']);commit(input.candidateCommit);commit(input.sourceTree);digest(input.auditSha256);digest(input.integritySha256);
 require(typeof input.candidate==='string'&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.candidate),'input-candidate');
 phase='source';require(await realpath(git(['rev-parse','--show-toplevel']))===root,'candidate-root');require(git(['rev-parse','HEAD'])===input.candidateCommit,'candidate-head');require(git(['rev-parse','HEAD^{tree}'])===input.sourceTree,'candidate-tree');require(git(['diff','--name-only','HEAD'])==='','candidate-tracked-diff');
 const {releaseStatusSchema,releaseArtifactSchema}=await import(pathToFileURL(join(root,'lib/release-verification.ts')).href);
 const {canonical}=await import(pathToFileURL(join(root,'lib/canonical-json.ts')).href);
 const artifact=releaseArtifactSchema.parse(input.candidateArtifact);require(artifact.name==='control-room-candidate-'+input.candidateCommit,'artifact-name');
 phase='audit';const auditRaw=await file(join(parent,'.github/cloud-implementation-audit.json'),65536);require(sha256(auditRaw)===input.auditSha256,'audit-digest');const audit=json(auditRaw);
 keys(audit,['format','version','sourceCommit','sourceTree','candidate','candidateArtifact','authoredBy','authoredAt','scope','phases','externalBoundaries']);
 require(audit.format==='control-room-cloud-implementation-audit'&&audit.version===1&&audit.authoredBy==='integrator'&&audit.scope==='cloud-implementation-only','audit-authority');
 require(audit.sourceCommit===input.candidateCommit&&audit.sourceTree===input.sourceTree&&audit.candidate===input.candidate&&canonical(releaseArtifactSchema.parse(audit.candidateArtifact))===canonical(artifact),'audit-source-artifact');
 require(typeof audit.authoredAt==='string'&&Number.isFinite(Date.parse(audit.authoredAt))&&Date.parse(audit.authoredAt)<=Date.now(),'audit-timestamp');
 require(canonical(audit.externalBoundaries)===canonical({hostedPrivateAcceptance:'owner-dependent',ownerDeviceAcceptance:'owner-dependent',providerExecution:'disabled',deployment:'not-performed'}),'audit-boundaries');
 require(Array.isArray(audit.phases)&&audit.phases.length===9,'audit-phases');const paths=[];
 for(let index=0;index<9;index++){
  const item=audit.phases[index];keys(item,['phase','status','finding','sourcePaths']);require(item.phase===index&&item.status==='cloud-implementation-complete'&&typeof item.finding==='string'&&item.finding.trim().length>0&&item.finding.length<=2000,'audit-phase-finding');
  require(Array.isArray(item.sourcePaths)&&item.sourcePaths.length>0&&item.sourcePaths.length<=16&&new Set(item.sourcePaths).size===item.sourcePaths.length,'audit-phase-paths');
  for(const path of item.sourcePaths){require(typeof path==='string'&&path.length<=512&&/^[A-Za-z0-9_.@+(), \[\]\/-]+$/.test(path)&&!path.startsWith('/')&&path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'audit-path');const kind=git(['cat-file','-t',input.candidateCommit+':'+path]);require(kind==='blob'||kind==='tree','audit-source-path');paths.push(path);}
 }
 phase='integrity';const integrityRaw=await file(join(parent,'artifact-verification.json'),65536);require(sha256(integrityRaw)===input.integritySha256,'integrity-digest');const integrity=json(integrityRaw);
 require(integrity.status==='INTEGRITY_VERIFIED_REVIEW_ONLY'&&integrity.sourceCommit===input.candidateCommit&&integrity.sourceGitTreeExactBytes===true&&integrity.outerZipSha256===artifact.sha256,'integrity-source');
 require(integrity.candidateArtifact?.id===artifact.id&&integrity.candidateArtifact.zipSha256===artifact.sha256&&integrity.candidateArtifact.workflowHead===input.candidateCommit&&integrity.candidateArtifact.runId===artifact.runId&&integrity.candidateArtifact.runConclusion==='success','integrity-candidate-artifact');
 require(integrity.helperArtifact?.workflowHead===input.candidateCommit&&integrity.helperArtifact.runConclusion==='success'&&integrity.helper?.sourceCommit===input.candidateCommit&&integrity.helper.ownerDeviceAcceptance===false&&integrity.helper.providerExecution===false,'integrity-helper');
 require(integrity.bridgeArtifact===null||integrity.bridgeArtifact?.workflowHead===input.candidateCommit&&integrity.bridgeArtifact.runConclusion==='success','integrity-bridge');
 require(Number.isSafeInteger(integrity.sourceFiles)&&integrity.sourceFiles>0&&integrity.sourceFiles<=20000&&Number.isSafeInteger(integrity.buildFiles)&&integrity.buildFiles>0&&integrity.buildFiles<=20000&&integrity.bridgeFiles===49,'integrity-counts');
 require(integrity.releaseAccepted===false&&integrity.deployed===false&&integrity.providerExecution===false&&integrity.ownerDeviceAcceptance===false,'integrity-boundaries');keys(integrity.negativeControls,NEGATIVE);require(NEGATIVE.every(key=>integrity.negativeControls[key]==='rejected'),'integrity-negative-controls');
 phase='original-ledger';const originalRaw=await file(join(root,'final-cloud-ledger-status.json'),1000000),originalReportRaw=await file(join(root,'release-ledger-verification.json'),65536),originalReport=json(originalReportRaw),before=releaseStatusSchema.parse(json(originalRaw));
 const originalBlocked=[...EXTERNAL,'implementation','hostedAcceptance'];
 require(before.sourceCommit===input.candidateCommit&&before.candidate===input.candidate&&canonical(before.artifact)===canonical(artifact),'ledger-source-artifact');
 require(before.phases.implementation==='in-progress'&&before.phases.localVerification==='passed'&&before.phases.hostedAcceptance==='owner-dependent','ledger-phases');
 require(before.checks.length===13&&CLOUD.every(id=>before.checks.filter(check=>check.id===id&&check.status==='passed'&&check.evidence?.kind==='github-actions').length===1)&&EXTERNAL.every(id=>before.checks.filter(check=>check.id===id&&check.status==='owner-dependent'&&check.evidence===null&&typeof check.limitation==='string'&&check.limitation.length>0).length===1),'ledger-checks');
 require(originalReport.format==='control-room-final-cloud-ledger-diagnostic'&&originalReport.status==='cloud-recorded-release-blocked'&&originalReport.sourceCommit===input.candidateCommit&&originalReport.candidate===input.candidate&&originalReport.statusSha256===sha256(originalRaw)&&canonical(originalReport.candidateArtifact)===canonical(artifact),'ledger-report');
 require(originalReport.verification?.exitCode===1&&originalReport.verification.candidate===input.candidate&&originalReport.verification.accepted===false&&sameSet(originalReport.verification.blocked,originalBlocked)&&originalReport.releaseAccepted===false&&originalReport.deployed===false&&originalReport.providerExecution===false&&originalReport.ownerDeviceAcceptance===false,'ledger-report-blockers');
 const statusPath=join(root,'docs/releases',input.candidate,'status.json');require(sha256(await file(statusPath,1000000))===sha256(originalRaw),'ledger-cli-copy');
 phase='original-strict-verification';const beforeVerification=verify(input.candidate,originalBlocked);
 phase='annotation';const changed=structuredClone(before);changed.phases.implementation='complete';const after=releaseStatusSchema.parse(changed),restored=structuredClone(after);restored.phases.implementation=before.phases.implementation;
 require(canonical(restored)===canonical(before),'annotation-other-fields');const afterRaw=Buffer.from(JSON.stringify(after,null,2)+'\n');
 restorePath=statusPath;restoreRaw=originalRaw;await atomicStatus(statusPath,afterRaw);
 phase='annotated-strict-verification';const afterVerification=verify(input.candidate,[...EXTERNAL,'hostedAcceptance']);
 require(sha256(await file(statusPath,1000000))===sha256(afterRaw),'annotated-status-changed');
 require(sha256(await file(join(root,'final-cloud-ledger-status.json'),1000000))===sha256(originalRaw)&&sha256(await file(join(root,'release-ledger-verification.json'),65536))===sha256(originalReportRaw),'original-files-changed');
 phase='output';await writeFile(join(root,OUTPUT),afterRaw,{flag:'wx',mode:0o600});
 await report({format:'control-room-cloud-implementation-annotation',version:1,status:'cloud-implementation-complete-release-blocked',sourceCommit:input.candidateCommit,sourceTree:input.sourceTree,candidate:input.candidate,candidateArtifact:artifact,
  inputSha256:sha256(inputRaw),auditSha256:sha256(auditRaw),integritySha256:sha256(integrityRaw),originalLedgerVerificationSha256:sha256(originalReportRaw),beforeStatusSha256:sha256(originalRaw),afterStatusSha256:sha256(afterRaw),
  hashProvenance:{audit:'Explicit integrator-authored conditional cloud-only source audit in the diagnostic checkout.',integrity:'Runtime SHA256 of the actual same-job inspector output; not an independently supplied report digest.',input:'Runtime binding of explicit source/artifact/audit identity and actual emitted report digest.'},
  changedFields:['phases.implementation'],beforePhases:before.phases,afterPhases:after.phases,allOtherFieldsCanonicalEqual:true,originalFourBlockerFilesPreserved:true,
  actualCounts:{cloudPassed:before.checks.filter(check=>CLOUD.includes(check.id)&&check.status==='passed').length,externalOwnerDependent:before.checks.filter(check=>EXTERNAL.includes(check.id)&&check.status==='owner-dependent').length,auditedPhases:audit.phases.length,auditedSourcePaths:paths.length,distinctAuditedSourcePaths:new Set(paths).size,sourceFiles:integrity.sourceFiles,buildFiles:integrity.buildFiles,bridgeFiles:integrity.bridgeFiles,integrityNegativeControls:NEGATIVE.length},
  beforeVerification,afterVerification,releaseAccepted:false,deployed:false,providerExecution:false,ownerDeviceAcceptance:false});
 restorePath=null;restoreRaw=null;console.log(JSON.stringify({status:'cloud-implementation-complete-release-blocked',candidate:input.candidate,releaseAccepted:false,blocked:afterVerification.blocked}));
}
try{await main();}catch(error){
 let restored=false;if(restorePath&&restoreRaw)try{await atomicStatus(restorePath,restoreRaw);restored=true;}catch{}
 const failure={format:'control-room-cloud-implementation-annotation',version:1,status:'failed',phase,reason:error instanceof AnnotationError?error.code:'unexpected-annotation-error',originalCliStatusRestored:restored,releaseAccepted:false,deployed:false,providerExecution:false,ownerDeviceAcceptance:false};
 if(root)try{await report(failure);}catch{}console.error(JSON.stringify(failure));process.exitCode=1;
}
