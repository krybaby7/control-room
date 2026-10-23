import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildAreaStory} from '../lib/history/story.ts';
import {buildAreaProgress,type ProgressInput} from '../lib/history/progress.ts';
import {owner,watermark,workspace,body,checked,item,now} from './fixtures/history-understanding.ts';
test('story Finished, Still open, Next retain distinct provenance and never turn cancellation into completion',async()=>{
 const request=await checked(await body('request','Finish physical acceptance.')),implementation=await checked(await body('implementation','Harness implemented.','assistant'),'implementation'),cancellation=await checked(await body('cancel','Cancel obsolete device.'),'cancellation');
 const items=[item('physical',[request.claim.id]),item('software',[implementation.claim.id],{state:'observed_finished'}),item('cancelled',[cancellation.claim.id],{state:'cancelled'})];
 const input={ownerId:owner,projectId:'project',areaId:'app',planningRevision:7,sourceWatermark:watermark,associationVersion:'rules-v1',extractorVersion:'extractor-v1',generatedAt:now,workspace,items,claims:[request,implementation,cancellation],unknowns:['Cloud history unavailable.'],contradictions:['Physical check is still pending.'],trustAcceptance:async()=>false,next:[{text:'Run physical acceptance.',claimIds:[request.claim.id],taskId:null}]};
 const first=await buildAreaStory(input);assert.equal(first.story.finished.length,1);assert.equal(first.story.finished[0].basis,'inferred');assert.equal(first.story.finished[0].acceptanceRef,null);assert.equal(first.story.open[0].workItemId,'physical');assert.equal(first.story.next[0].taskId,null);assert.equal(first.story.finished.some(f=>f.text.includes('Cancel')),false);assert.ok(first.story.unknowns.includes('Cloud history unavailable.'));
 assert.equal((await buildAreaStory(input)).story.id,first.story.id);
 assert.notEqual((await buildAreaStory({...input,generatedAt:'2026-10-22T00:00:01.000Z'})).story.id,first.story.id);
 assert.notEqual((await buildAreaStory({...input,planningRevision:8})).story.id,first.story.id);
 await assert.rejects(buildAreaStory({...input,acceptedEntries:[{text:'Owner accepted.',claimIds:[],acceptanceRef:'forged'}]}),/owner provenance/);
 await assert.rejects(buildAreaStory({...input,next:[{text:'Do it',claimIds:[request.claim.id],taskId:'invented'}]}),/foreign/);
 const accepted=await buildAreaStory({...input,acceptedEntries:[{text:'Owner accepted this scope.',claimIds:[],acceptanceRef:'native-grant'}],trustAcceptance:async ref=>ref==='native-grant'});assert.equal(accepted.story.finished[1].basis,'accepted');
});
test('progress has no inferred denominator, trusted acceptance stays separate and mixed checkpoints stay mixed',async()=>{
 const implementation=await checked(await body('implementation','Harness implemented.','tool'),'implementation',{basis:'observed'});
 const input:ProgressInput={ownerId:owner,projectId:'project',areaId:'app',planningRevision:7,sourceWatermark:watermark,workspace,items:[item('software',[implementation.claim.id],{state:'observed_finished'})],claims:[implementation],scope:null,assessments:[],coverageComplete:false,unknowns:['Missing attachment.'],trustAgreement:async()=>false,trustAssessment:async()=>false,trustTaskCompletion:async()=>false,checkpointEvidence:()=>({stage:'unknown',claimIds:[]})};
 const unset=await buildAreaProgress(input);assert.equal(unset.roadmap,null);assert.equal(unset.coverageComplete,false);assert.deepEqual(unset.observedFinishedWorkItemIds,['software']);assert.deepEqual(unset.acceptedTaskIds,[]);assert.equal('percentage' in unset,false);
 const scope={id:'scope',projectId:'project',areaId:'app',revision:2,agreedAt:now,checkpoints:[{id:'software',label:'Software',acceptance:'Software scoped result.',mandatory:true,milestoneId:null,taskIds:[]},{id:'physical',label:'Physical',acceptance:'Physical check.',mandatory:true,milestoneId:null,taskIds:[]}]};
 const assessment={id:'assessment:0001',scopeId:'scope',scopeRevision:2,checkpointId:'software',verdict:'accepted' as const,reason:'Owner checked.',claimIds:[implementation.claim.id],recordedAt:now};
 assert.equal((await buildAreaProgress({...input,scope,assessments:[assessment]})).roadmap,null);
 const progress=await buildAreaProgress({...input,scope,assessments:[assessment],trustAgreement:async()=>true,trustAssessment:async()=>true,checkpointEvidence:id=>id==='software'?{stage:'implemented',claimIds:[implementation.claim.id]}:{stage:'unknown',claimIds:[]}});
 assert.equal(progress.roadmap!.defined,2);assert.equal(progress.roadmap!.ownerAccepted,1);assert.deepEqual(progress.roadmap!.checkpoints.map(c=>c.observedStage),['implemented','unknown']);
 const historical=await buildAreaProgress({...input,scope,assessments:[{...assessment,scopeRevision:1}],trustAgreement:async()=>true,trustAssessment:async()=>true});assert.equal(historical.roadmap!.ownerAccepted,0);
 await assert.rejects(buildAreaProgress({...input,scope,trustAgreement:async()=>true,checkpointEvidence:()=>({stage:'verified',claimIds:[implementation.claim.id]})}),/exceeds/);
});
