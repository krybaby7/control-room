import {z} from 'zod';
/** Evidence validates identity and provenance, never activates a capability or changes owner state. */
export const RELEASE_REPOSITORY='krybaby7/control-room' as const;
export const RELEASE_CHECKS=[
 {id:'node-tests',environment:'isolated-ci',procedure:'npm test',stepNames:['Run npm test']},
 {id:'bridge-tests',environment:'isolated-ci',procedure:'npm run test:bridge',stepNames:['Run npm run test:bridge']},
 {id:'typecheck',environment:'isolated-ci',procedure:'npm run typecheck',stepNames:['Run npm run typecheck']},
 {id:'lint',environment:'isolated-ci',procedure:'npm run lint',stepNames:['Run npm run lint']},
 {id:'build',environment:'isolated-ci',procedure:'npm run build',stepNames:['Run npm run build']},
 {id:'d1-recovery',environment:'isolated-ci',procedure:'npm run test:workspace-d1',stepNames:['Run npm run test:workspace-d1']},
 {id:'r2-recovery',environment:'isolated-ci',procedure:'npm run test:attachment-recovery-r2',stepNames:['Run npm run test:attachment-recovery-r2']},
 {id:'chromium',environment:'isolated-ci',procedure:'npm run test:e2e',stepNames:['Run npm run test:e2e']},
 {id:'r2-chromium',environment:'isolated-ci',procedure:'npm run test:e2e:r2',stepNames:['Run npm run test:e2e:r2']},
 {id:'oversized-owner-recovery',environment:'isolated-replacement',procedure:'Restore an exact owner-size supported recovery package into an isolated replacement, including reviewed private continuity and actual attachment bytes.',stepNames:[]},
 {id:'performance',environment:'controlled-staging',procedure:'Measure documented capacity fixtures, concurrency and p50/p95 budgets against the exact candidate.',stepNames:[]},
 {id:'hosted-private-acceptance',environment:'private-staging',procedure:'Observe the exact private published artifact, bindings, migrations, gateway authentication and owner session.',stepNames:[]},
 {id:'owner-device-acceptance',environment:'owner-device',procedure:'Owner observes the enabled physical-device workflows on their actual devices.',stepNames:[]},
] as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/),positive=z.number().int().positive().safe();
const stamp=z.string().datetime({offset:true}),text=z.string().trim().min(1).max(2000);
const checkId=z.enum(RELEASE_CHECKS.map(check=>check.id) as [typeof RELEASE_CHECKS[number]['id'],...typeof RELEASE_CHECKS[number]['id'][]]);
export const releaseArtifactSchema=z.object({id:positive,name:z.string().min(1).max(255),sha256:sha,bytes:z.number().int().nonnegative().safe(),runId:positive}).strict();
export const githubReleaseEvidenceSchema=z.object({kind:z.literal('github-actions'),repository:z.literal(RELEASE_REPOSITORY),sourceCommit:commit,runId:positive,runAttempt:positive,jobId:positive,stepNumber:positive,stepName:text,runUrl:z.string().url(),jobUrl:z.string().url(),artifact:releaseArtifactSchema,verifiedAt:stamp}).strict().superRefine((value,ctx)=>{
 if(value.runUrl!=='https://github.com/'+value.repository+'/actions/runs/'+value.runId||value.jobUrl!==value.runUrl+'/job/'+value.jobId)ctx.addIssue({code:'custom',message:'Evidence URLs must match exact repository/run/job identity.'});
 if(value.artifact.runId!==value.runId)ctx.addIssue({code:'custom',message:'Evidence artifact belongs to another run.'});
});
export const releaseCheckSchema=z.object({id:checkId,status:z.enum(['not-run','passed','failed','unavailable','owner-dependent','not-applicable']),environment:text,observedAt:stamp.nullable(),commandOrProcedure:text,evidencePath:z.string().min(1).max(2000).nullable(),limitation:text.nullable(),disabledScope:text.nullable(),evidence:githubReleaseEvidenceSchema.nullable()}).strict();
export const releaseStatusSchema=z.object({format:z.literal('control-room-release-status'),version:z.literal(1),candidate:z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),sourceCommit:commit.nullable(),artifactSha256:sha.nullable(),artifact:releaseArtifactSchema.nullable(),phases:z.object({implementation:z.enum(['in-progress','complete']),localVerification:z.enum(['not-run','passed','failed']),hostedAcceptance:z.enum(['not-run','passed','failed','owner-dependent','unavailable'])}).strict(),checks:z.array(releaseCheckSchema).length(RELEASE_CHECKS.length)}).strict().superRefine((value,ctx)=>{
 const seen=new Set<string>();
 if(value.artifact&&value.artifact.name!=='control-room-candidate-'+value.sourceCommit)ctx.addIssue({code:'custom',message:'Candidate must name the exact source artifact, not an unrelated build output.'});
 if((value.artifact===null)!==(value.artifactSha256===null)||value.artifact&&value.artifact.sha256!==value.artifactSha256)ctx.addIssue({code:'custom',message:'Candidate artifact digest and identity must agree.'});
 for(const check of value.checks){
  const spec=RELEASE_CHECKS.find(spec=>spec.id===check.id)!;
  if(seen.has(check.id))ctx.addIssue({code:'custom',message:'Duplicate release gate.'});seen.add(check.id);
  if(check.environment!==spec.environment||check.commandOrProcedure!==spec.procedure)ctx.addIssue({code:'custom',message:'Gate procedure/environment differs from closed release contract.'});
  if(check.status==='passed'){
   if(!value.sourceCommit||!value.artifact||!check.observedAt||!check.evidencePath||!check.evidence||check.limitation!==null||check.disabledScope!==null)ctx.addIssue({code:'custom',message:'Passed gate needs exact source, candidate artifact, timestamp and verified evidence.'});
   if(check.evidence&&(check.evidence.sourceCommit!==value.sourceCommit||!spec.stepNames.some(name=>name===check.evidence!.stepName)))ctx.addIssue({code:'custom',message:'Passed gate evidence does not match source/step.'});
  }else if(check.evidence!==null)ctx.addIssue({code:'custom',message:'Non-passed gates cannot carry a success proof.'});
  if(check.status==='not-applicable'){
   // No release-critical gate is currently optional. Disabled capabilities remain explicit blocked evidence.
   ctx.addIssue({code:'custom',message:'No required release gate currently permits not-applicable.'});
  }
  if(check.status!=='passed'&&check.status!=='not-run'&&!check.limitation)ctx.addIssue({code:'custom',message:'Incomplete gate requires an explicit limitation.'});
  if(check.status==='not-run'&&(check.observedAt!==null||check.evidencePath!==null))ctx.addIssue({code:'custom',message:'Unrun gate cannot claim an observation.'});
 }
 if(seen.size!==RELEASE_CHECKS.length)ctx.addIssue({code:'custom',message:'Required release gates are missing.'});
 const local=value.checks.filter(check=>check.environment==='isolated-ci');
 if(value.phases.localVerification==='passed'&&local.some(check=>check.status!=='passed'))ctx.addIssue({code:'custom',message:'Local verification cannot pass with missing CI gates.'});
 if(value.phases.hostedAcceptance==='passed'&&value.checks.some(check=>check.status!=='passed'))ctx.addIssue({code:'custom',message:'Hosted acceptance cannot pass with incomplete required gates.'});
});
export type ReleaseStatus=z.infer<typeof releaseStatusSchema>;
export type ReleaseCheckId=typeof RELEASE_CHECKS[number]['id'];
export function newReleaseStatus(candidate:string):ReleaseStatus{
 return releaseStatusSchema.parse({format:'control-room-release-status',version:1,candidate,sourceCommit:null,artifactSha256:null,artifact:null,phases:{implementation:'in-progress',localVerification:'not-run',hostedAcceptance:'owner-dependent'},checks:RELEASE_CHECKS.map(check=>({id:check.id,status:'not-run',environment:check.environment,observedAt:null,commandOrProcedure:check.procedure,evidencePath:null,limitation:null,disabledScope:null,evidence:null}))});
}
export function releaseAcceptance(raw:unknown):{accepted:boolean;blocked:string[]}{
 const value=releaseStatusSchema.parse(raw),blocked=value.checks.filter(check=>check.status!=='passed').map(check=>check.id as string);
 if(value.phases.implementation!=='complete')blocked.push('implementation');
 if(value.phases.localVerification!=='passed')blocked.push('localVerification');
 if(value.phases.hostedAcceptance!=='passed')blocked.push('hostedAcceptance');
 return {accepted:blocked.length===0,blocked};
}
const apiRun=z.object({id:positive,head_sha:commit,status:z.literal('completed'),conclusion:z.literal('success'),run_attempt:positive,html_url:z.string().url(),repository:z.object({full_name:z.literal(RELEASE_REPOSITORY)}).passthrough()}).passthrough();
const apiJob=z.object({id:positive,run_id:positive,head_sha:commit,status:z.literal('completed'),conclusion:z.literal('success'),html_url:z.string().url(),steps:z.array(z.object({number:positive,name:text,status:z.literal('completed'),conclusion:z.string(),completed_at:stamp.nullable()}).passthrough()).max(1000)}).passthrough();
const apiArtifact=z.object({id:positive,name:z.string().min(1).max(255),size_in_bytes:z.number().int().nonnegative().safe(),expired:z.literal(false),digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),workflow_run:z.object({id:positive,head_sha:commit}).passthrough()}).passthrough();
/** Inputs are responses fetched from the fixed GitHub API origin by the recorder, not owner-submitted proofs. */
export function verifyGitHubArtifact(input:{sourceCommit:string;run:unknown;artifact:unknown}):z.infer<typeof releaseArtifactSchema>{
 const source=commit.parse(input.sourceCommit),run=apiRun.parse(input.run),artifact=apiArtifact.parse(input.artifact);
 if(run.head_sha!==source||artifact.workflow_run.head_sha!==source||artifact.workflow_run.id!==run.id||run.html_url!=='https://github.com/'+RELEASE_REPOSITORY+'/actions/runs/'+run.id)throw new Error('Artifact source/run identity differs.');
 return releaseArtifactSchema.parse({id:artifact.id,name:artifact.name,sha256:artifact.digest.slice(7),bytes:artifact.size_in_bytes,runId:run.id});
}
export function verifyGitHubCheck(input:{checkId:ReleaseCheckId;sourceCommit:string;run:unknown;job:unknown;artifact:unknown;stepNumber:number;now:string;attemptJobIds:number[]}):{observedAt:string;evidence:z.infer<typeof githubReleaseEvidenceSchema>}{
 const spec=RELEASE_CHECKS.find(check=>check.id===input.checkId);if(!spec||!spec.stepNames.length)throw new Error('This acceptance gate requires external observed evidence; CI cannot attest to it.');
 const run=apiRun.parse(input.run),job=apiJob.parse(input.job),artifact=verifyGitHubArtifact(input);
 if(!z.array(positive).max(1000).parse(input.attemptJobIds).includes(job.id))throw new Error('Job does not belong to the exact completed run attempt.');
 if(job.run_id!==run.id||job.head_sha!==input.sourceCommit||job.html_url!=='https://github.com/'+RELEASE_REPOSITORY+'/actions/runs/'+run.id+'/job/'+job.id)throw new Error('Job source/run identity differs.');
 const step=job.steps.find(step=>step.number===positive.parse(input.stepNumber));
 if(!step||step.conclusion!=='success'||!step.completed_at||!spec.stepNames.some(name=>name===step.name))throw new Error('Exact gate step did not complete successfully.');
 const now=stamp.parse(input.now);if(Date.parse(step.completed_at)>Date.parse(now)+300000)throw new Error('Evidence timestamp is in the future.');
 return {observedAt:step.completed_at,evidence:githubReleaseEvidenceSchema.parse({kind:'github-actions',repository:RELEASE_REPOSITORY,sourceCommit:input.sourceCommit,runId:run.id,runAttempt:run.run_attempt,jobId:job.id,stepNumber:step.number,stepName:step.name,runUrl:run.html_url,jobUrl:job.html_url,artifact,verifiedAt:now})};
}
