import test from 'node:test';
import assert from 'node:assert/strict';
import type {z} from 'zod';
import {jobReadRowSchema,type JobReadModel} from '../lib/agents/read-model.ts';
import {reviewHref} from '../lib/review-links.ts';
import {buildReviewAttention} from '../lib/review-attention.ts';
import type {EvidenceSnapshot} from '../lib/evidence-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {buildAttention,attentionPage} from '../lib/attention.ts';
import {deriveOwnerAttentionFindings,loadOwnerAttentionFindings,attentionReviewSchema,attentionSourceListSchema,attentionScheduleListSchema} from '../lib/attention-findings.ts';
const now='2026-10-18T12:00:00.000Z',revision=1,workspace=createSeedWorkspace(now),projectId=workspace.projects[0].id,taskId=workspace.tasks[0].id;
function input():{review:z.infer<typeof attentionReviewSchema>;sources:z.infer<typeof attentionSourceListSchema>;schedules:z.infer<typeof attentionScheduleListSchema>;jobs:JobReadModel[]}{
 return {review:{revision,asOf:now,items:[{id:'requirement:synthetic',kind:'missing-evidence',subject:{type:'task',id:taskId},projectId,title:'Review evidence: synthetic criterion',reasons:['No exact current evidence supports this required criterion.','Attachment bytes have not been verified by this metadata read.'],href:'/?view=evidence'}]},
 sources:{revision,asOf:now,connections:[{rowRevision:1,value:{id:'synthetic-connection',provider:'documents',label:'Synthetic document',accessMode:'interactive',enabled:true,archivedAt:null}}],targets:[{rowRevision:1,value:{id:'synthetic-source',connectionId:'synthetic-connection',projectId,kind:'document',providerResourceId:'synthetic-document',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null},state:{paused:false,operationalRevision:1,attemptedAt:null,lastSuccessAt:null,lastSourceRevision:null,failure:null,retryAt:null,failureCount:0},manualImportAvailable:true,automaticRead:'unverified'}]},
 schedules:{revision,asOf:now,schedules:[{rowRevision:1,value:{id:'synthetic-schedule',kind:'daily_review',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'03:00'},sourceId:null,projectIds:[projectId],catchUp:'latest_only',createdAt:now,updatedAt:now,archivedAt:null},runtime:{paused:true,nextDueAt:now,lastAttemptAt:null,lastSuccessAt:null,failure:'principal_unavailable',retryAt:null},canResume:false}],unattended:'unverified'},
 jobs:[{revision,generatedAt:now,budgets:[],jobs:[],evaluations:[],nextJobAfter:null,nextEvaluationAfter:null,execution:{enabled:false,diagnostic:'private_ingress_unavailable'}}]};
}
async function job(id:string,status:JobReadModel['jobs'][number]['status']='failed'){
 const spec={schemaVersion:1,operation:'project.inspect',projectId,taskId,baseWorkspaceRevision:1,taskSnapshotSha256:'a'.repeat(64),repositoryKey:'synthetic-repository',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'gpt-6.1-sol',effort:'high',timeoutSeconds:60,outputBytesLimit:1000,dependsOnJobIds:[]};
 return jobReadRowSchema.parse({record:{id,intentId:'intent-'+id,spec,specSha256:await contentHash(canonical(spec)),createdAt:now,retryOfJobId:null,historical:false},rowRevision:1,status,operationalRevision:1,attempt:null,result:null,resultHash:null,approvalCandidate:null,accepted:false});
}
test('owner metadata produces evidence, unknown/stale source, blocked schedule and failed/reconciliation findings without effects',async()=>{
 const data=input(),failed=await job('synthetic-job-failed'),uncertain=await job('synthetic-job-uncertain','reconcile_required');
 const withJobs={...data,jobs:[{...data.jobs[0],jobs:[failed,uncertain]}]},before=canonical({workspace,withJobs});
 const result=await deriveOwnerAttentionFindings(workspace,revision,withJobs);
 assert.equal(canonical({workspace,withJobs}),before);assert.equal(result.findings.length,5);
 const source=result.findings.find(row=>row.entityType==='source')!;assert.equal(source.sortAt,null);assert.match(source.reasons.join(' '),/unknown/);assert.match(source.reasons.join(' '),/unverified/);assert.ok(!source.reasons.some(reason=>reason==='fresh'));
 const reconciliation=result.findings.find(row=>row.entityId==='synthetic-job-uncertain')!;assert.equal(reconciliation.severity,'action');assert.match(reconciliation.reasons.join(' '),/unconfirmed/);
 const all=buildAttention(workspace,{date:'2026-10-18',findings:result.findings}),filtered=attentionPage(all,{kind:'missing-evidence',projectId});assert.ok(filtered.items.some(row=>row.entityId===taskId));assert.equal(attentionPage(all,{kind:'failed-job',projectId}).total,3);
 assert.ok(!canonical(result).includes('deviceCredential'));assert.equal(result.readAt.jobs,now);
});
test('last success survives failure; future time remains unknown and provider failure details are closed',async()=>{
 const data=input();data.sources.targets[0].state.lastSuccessAt='2026-10-17T12:00:00.000Z';data.sources.targets[0].state.failure='upstream_error';data.sources.targets[0].state.failureCount=1;
 const result=await deriveOwnerAttentionFindings(workspace,revision,data),source=result.findings.find(row=>row.entityType==='source')!;
 assert.equal(source.sortAt,'2026-10-17T12:00:00.000Z');assert.match(source.reasons.join(' '),/older/);assert.match(source.reasons.join(' '),/did not complete/);
 data.sources.targets[0].state.lastSuccessAt='2026-10-19T12:00:00.000Z';
 assert.match((await deriveOwnerAttentionFindings(workspace,revision,data)).findings.find(row=>row.entityType==='source')!.reasons.join(' '),/ahead.*unknown/);
 data.sources.targets[0].state.failure='token=synthetic-sensitive /private/path' as never;await assert.rejects(deriveOwnerAttentionFindings(workspace,revision,data));
});
test('owner revision, exact job hashes, safe links and project identities fail closed',async()=>{
 const data=input();
 await assert.rejects(deriveOwnerAttentionFindings(workspace,2,data));
 const forged=await job('synthetic-job');forged.record.specSha256='c'.repeat(64);await assert.rejects(deriveOwnerAttentionFindings(workspace,revision,{...data,jobs:[{...data.jobs[0],jobs:[forged]}]}));
 data.review.items[0].href='https://synthetic.invalid/private';await assert.rejects(deriveOwnerAttentionFindings(workspace,revision,data));
 data.review.items[0].href='/?view=evidence';data.review.items[0].projectId='synthetic-foreign-project';await assert.rejects(deriveOwnerAttentionFindings(workspace,revision,data));
});
test('all actual owner job pages are consumed exactly once; no silent first-page truncation',async()=>{
 const data=input(),first=await job('job-a'),second=await job('job-b','reconcile_required'),paths:string[]=[];
 const read=async(path:string):Promise<unknown>=>{paths.push(path);if(path==='/api/evidence/attention')return data.review;if(path==='/api/sources')return data.sources;if(path==='/api/automations')return data.schedules;if(path==='/api/jobs')return {...data.jobs[0],jobs:[first],nextJobAfter:'job-a'};if(path==='/api/jobs?afterJob=job-a')return {...data.jobs[0],jobs:[second]};throw new Error('Unexpected owner read');};
 const result=await loadOwnerAttentionFindings(workspace,revision,read);assert.equal(paths.filter(path=>path==='/api/evidence/attention').length,1);assert.ok(result.findings.some(row=>row.entityId==='job-b'));
 await assert.rejects(deriveOwnerAttentionFindings(workspace,revision,{...data,jobs:[{...data.jobs[0],jobs:[first],nextJobAfter:'job-a'}]}));
 await assert.rejects(loadOwnerAttentionFindings(workspace,revision,async path=>path.startsWith('/api/jobs')?{...data.jobs[0],jobs:[first],nextJobAfter:'job-a'}:read(path)));
});
test('oversize and ambiguous owner records reject instead of truncating or exposing partial findings',async()=>{
 const data=input();data.review.items[0].reasons=['x'.repeat(8_000_001)];await assert.rejects(deriveOwnerAttentionFindings(workspace,revision,data));
 const duplicate=input();duplicate.sources.targets.push(duplicate.sources.targets[0]);await assert.rejects(deriveOwnerAttentionFindings(workspace,revision,duplicate));
 const unavailable=input();unavailable.schedules.schedules=[];unavailable.sources.targets=[];unavailable.review.items=[];
 assert.deepEqual((await deriveOwnerAttentionFindings(workspace,revision,unavailable)).findings,[]);
});

test('actual evidence requirement assessment feeds the unified category without promoting metadata to verified bytes',async()=>{
 const subject={type:'task' as const,id:taskId};
 const snapshot:EvidenceSnapshot={revision,asOf:now,requirementRowRevisions:{'synthetic-required':1},evidenceHeads:[],evidenceVersions:[],evidenceMappings:[],links:[],requirements:[{id:'synthetic-required',label:'Synthetic physical criterion',scope:'physical-acceptance',required:true,maxAgeDays:7,candidate:'synthetic-candidate',requireAttachment:true,subject,archivedAt:null}],acceptances:[],decisionHeads:[],decisionVersions:[],attachments:[],attachmentUsage:null,legacyCounts:{},warnings:[],attachmentRecovery:'metadata-only'};
 const before=canonical({workspace,snapshot}),data=input();data.review.items=await buildReviewAttention(workspace,snapshot,now);
 const result=await deriveOwnerAttentionFindings(workspace,revision,data),finding=result.findings.find(row=>row.kind==='missing-evidence')!;
 assert.ok(finding);assert.equal(finding.entityId,taskId);assert.equal(finding.href,'/?view=evidence');assert.equal(canonical({workspace,snapshot}),before);
});

test('multiple immutable decision citations for one planning record retain every review link',async()=>{
 const data=input();data.review.items=[
 {id:'decision:decision-a:1',kind:'decision-review',subject:{type:'task',id:taskId},projectId,title:'Review decision A',reasons:['Recorded review date is due.'],href:reviewHref({kind:'decision',id:'decision-a',version:1})},
 {id:'decision:decision-b:2',kind:'decision-review',subject:{type:'task',id:taskId},projectId,title:'Review decision B',reasons:['Criteria changed.'],href:reviewHref({kind:'decision',id:'decision-b',version:2})}
 ];
 const found=await deriveOwnerAttentionFindings(workspace,revision,data),rows=buildAttention(workspace,{date:'2026-10-18',findings:found.findings}),group=attentionPage(rows,{kind:'review'}).items.find(row=>row.entityId===taskId)!;
 assert.ok(group);assert.ok(group.reviewLinks?.some(link=>link.href===data.review.items[0].href));assert.ok(group.reviewLinks?.some(link=>link.href===data.review.items[1].href));
});
