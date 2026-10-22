import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planAnalysis,runAnalysis,type AnalysisRunInput,type HistoryAnalysisAdapter} from '../lib/history/analysis.ts';
import {body,snapshot,claim,owner,now} from './fixtures/history-understanding.ts';
import type {HistorySegment} from '../lib/history/contracts.ts';
import {canonical} from '../lib/canonical-json.ts';
test('full selected history includes old requests and changed revisions; extractor, watermark and late-segment changes schedule catchup',async()=>{
 const old=await body('old','Old unresolved request.'),resumed=await body('new','Resume the old request.');
 old.message.occurredAt='2020-01-01T00:00:00.000Z';const input=snapshot([old,resumed]);
 const plan=await planAnalysis(input,[],[],'unicode-v1','extractor-v1');assert.deepEqual(plan.chunks.flatMap(c=>c.messageRevisionIds).sort(),['new','old']);assert.equal(plan.coverageProof,false);
 const first=plan.chunks[0],checkpoint={id:'analysis:'+first.inputDigest,sourceWatermark:input.sourceWatermark,inputDigest:first.inputDigest,normalizationVersion:'unicode-v1',extractorVersion:'extractor-v1',processedMessageRevisionIds:first.messageRevisionIds,processedSegmentIds:[],affectedAreaIds:[],state:'complete' as const};
 assert.equal((await planAnalysis(input,[],[checkpoint],'unicode-v1','extractor-v1')).chunks.length,plan.chunks.length,'imported complete JSON is not native checkpoint proof');
 assert.equal((await planAnalysis(input,[],[checkpoint],'unicode-v1','extractor-v1',()=>true)).chunks.length,plan.chunks.length-1);
 assert.equal((await planAnalysis(input,[],[checkpoint],'unicode-v1','extractor-v2',()=>true)).chunks.length,plan.chunks.length);
 assert.equal((await planAnalysis({...input,sourceWatermark:'later'},[],[checkpoint],'unicode-v1','extractor-v1',()=>true)).chunks.length,plan.chunks.length-1);
 const segment:HistorySegment={id:'late',sourceId:'source',conversationId:'old',nativeSegmentId:'native',inheritedFromSegmentId:null,inheritedRange:null,sha256:'a'.repeat(64),bytes:1,objectKey:'synthetic',availability:'complete',unavailableReason:null};
 assert.equal((await planAnalysis(input,[segment],[checkpoint],'unicode-v1','extractor-v1',()=>true)).chunks.length,plan.chunks.length-1);
 const missing=await planAnalysis(snapshot([{...old,requiredContentAvailable:false}]),[],[],'unicode-v1','extractor-v1');assert.equal(missing.chunks.length,0);assert.ok(missing.unknowns.length);
 const many=await Promise.all(Array.from({length:300},(_,i)=>body('message-'+i,'Retained source '+i+' '+'.'.repeat(250))));
 const bounded=await planAnalysis(snapshot(many),[],[],'unicode-v1','extractor-v1');assert.ok(bounded.chunks.length>1);assert.equal(new Set(bounded.chunks.flatMap(c=>c.messageRevisionIds)).size,300);assert.ok(bounded.chunks.every(c=>c.messageRevisionIds.length<=250&&new TextEncoder().encode(JSON.stringify(c.providerInput)).length<65536));
 const oversized=await planAnalysis(snapshot([await body('oversized','x'.repeat(70000))]),[],[],'unicode-v1','extractor-v1');assert.ok(oversized.chunks.length>1);assert.equal(oversized.unknowns.length,0);
 const metadataHeavy=snapshot([await body('metadata-heavy','Retained text. '.repeat(6000))]);metadataHeavy.contexts=[{...metadataHeavy.contexts[0],branch:'private-context-'+'.'.repeat(50000)}];
 const metadataPlan=await planAnalysis(metadataHeavy,[],[],'unicode-v1','extractor-v1');assert.ok(metadataPlan.chunks.length>1);assert.equal(metadataPlan.chunks.flatMap(c=>c.providerInput.spans).map(s=>s.text).join(''),metadataHeavy.messages[0].text);assert.ok(metadataPlan.chunks.every(c=>c.providerInput.contexts.length===0&&c.providerInput.metadataOmissions.contexts===1));assert.match(metadataPlan.unknowns[0],/retained privately/);
});
test('oversized Unicode messages use every bounded span, global citations and native checkpoint aggregation across crash/replay',async()=>{
 const original=await body('large-message','😀ع\n"'.repeat(24000)+'END😀'),pinned=snapshot([original]),points=Array.from(original.text);
 const plan=await planAnalysis(pinned,[],[],'unicode-v1','extractor-v1');assert.ok(plan.chunks.length>2);assert.equal(plan.unknowns.length,0);
 const spans=plan.chunks.flatMap(c=>c.providerInput.spans);let through=0;
 for(const span of spans){assert.equal(span.start,through);assert.equal(span.text,points.slice(span.start,span.end).join(''));assert.match(span.spanDigest,/^[a-f0-9]{64}$/);assert.ok(!/[\uD800-\uDBFF]$/u.test(span.text));through=span.end;}
 assert.equal(through,points.length);assert.equal(spans.map(s=>s.text).join(''),original.text);
 const native=new Set<string>(),trust=(checkpoint:Parameters<NonNullable<Parameters<typeof planAnalysis>[5]>>[0])=>native.has(canonical(checkpoint));
 const prior=[] as import('../lib/history/contracts.ts').AnalysisCheckpoint[];let calls=0;const journal=new Set<string>();
 const adapter:HistoryAnalysisAdapter={provider:'synthetic-provider',model:'synthetic-exact-model',async analyze(input){
  calls++;const serialized=JSON.stringify(input);assert.ok(new TextEncoder().encode(serialized).length<=65536);assert.equal('snapshot' in input,false);assert.equal(serialized.includes(original.text),false);assert.equal(serialized.includes(owner),false);assert.equal(serialized.includes(original.message.bodyObjectKey),false);
  const span=input.providerInput.spans.at(-1)!;const end=span.end,start=Math.max(span.start,end-4);
  return {provider:this.provider,model:this.model,output:{claims:[{...claim(original),id:'span-claim:'+start,text:'Synthetic cited span.',citations:[{messageRevisionId:original.message.id,revisionDigest:original.message.revisionDigest,start,end}]}]},inputTokens:1,outputTokens:1,costDollars:0};
 }};
 const policy={id:'analysis' as const,enabled:true,provider:adapter.provider,model:adapter.model,maxCostDollars:1,maxInputBytes:65536,maxOutputTokens:1000,timeoutMs:1000},consent={ownerId:owner,provider:adapter.provider,model:adapter.model,sourceIds:['source'],privacyScope:'selected_history' as const,expiresAt:'2027-01-01T00:00:00.000Z',renewableAccess:true};
 const input=(chunk:typeof plan.chunks[number]):AnalysisRunInput=>({chunk,policy,consent,adapter,now,reserve:async digest=>{if(journal.has(digest))return 'uncertain';journal.add(digest);return 'admitted';},verifySupport:async()=>({supported:true,contradictions:[]})});
 const first=await runAnalysis(input(plan.chunks[0]));assert.equal(first.checkpoint.state,'complete');assert.deepEqual(first.checkpoint.processedMessageRevisionIds,[]);
 // Crash after provider response, before native publication: the page is still
 // pending, but the durable call journal blocks a second paid invocation.
 assert.equal((await runAnalysis(input(plan.chunks[0]))).checkpoint.state,'unavailable');assert.equal(calls,1);
 const imported=await planAnalysis(pinned,[],[first.checkpoint],'unicode-v1','extractor-v1');assert.equal(imported.chunks.length,plan.chunks.length);assert.equal(imported.completionCheckpoint,null);
 native.add(canonical(first.checkpoint));prior.push(first.checkpoint);
 const resumed=await planAnalysis(pinned,[],prior,'unicode-v1','extractor-v1',trust);assert.equal(resumed.chunks.length,plan.chunks.length-1);assert.deepEqual(resumed.completedMessageRevisionIds,[]);assert.equal(resumed.completionCheckpoint,null);
 for(const chunk of resumed.chunks){const result=await runAnalysis(input(chunk));assert.equal(result.checkpoint.state,'complete');assert.deepEqual(result.checkpoint.processedMessageRevisionIds,[]);native.add(canonical(result.checkpoint));prior.push(result.checkpoint);}
 assert.equal(calls,plan.chunks.length);
 const finished=await planAnalysis(pinned,[],prior,'unicode-v1','extractor-v1',trust);assert.equal(finished.chunks.length,0);assert.deepEqual(finished.completedMessageRevisionIds,['large-message']);assert.deepEqual(finished.completionCheckpoint!.processedMessageRevisionIds,['large-message']);
 native.add(canonical(finished.completionCheckpoint));assert.equal((await planAnalysis(pinned,[],[...prior,finished.completionCheckpoint!],'unicode-v1','extractor-v1',trust)).completionCheckpoint,null);
 // A global citation crossing an internal span boundary is valid only when
 // both adjacent spans were actually supplied in this one provider envelope.
 const firstChunk=plan.chunks[0],boundary=firstChunk.providerInput.spans[0].end;
 const crossing={...claim(original),text:'Cross-span synthetic fact.',citations:[{messageRevisionId:original.message.id,revisionDigest:original.message.revisionDigest,start:boundary-1,end:boundary+1}]};
 const withOutput=(output:unknown):HistoryAnalysisAdapter=>({...adapter,async analyze(){return {provider:adapter.provider,model:adapter.model,output,inputTokens:1,outputTokens:1,costDollars:0};}});
 const cross=await runAnalysis({...input(firstChunk),reserve:async()=> 'admitted',adapter:withOutput({claims:[crossing]})});assert.equal(cross.checkpoint.state,'complete');assert.equal(cross.claims[0].citations[0].text,points.slice(boundary-1,boundary+1).join(''));
 const unsupported=await runAnalysis({...input(firstChunk),reserve:async()=> 'admitted',adapter:withOutput({claims:[{...crossing,citations:[{...crossing.citations[0],end:points.length}]}]})});assert.equal(unsupported.checkpoint.state,'unavailable');assert.deepEqual(unsupported.checkpoint.processedMessageRevisionIds,[]);assert.match(unsupported.diagnostics[0],/pending.*span support/);assert.deepEqual(unsupported.claims,[]);assert.equal(unsupported.pendingClaims[0].citations[0].start,boundary-1);assert.equal(unsupported.pendingClaims[0].citations[0].end,points.length);
 const last=plan.chunks.at(-1)!,endClaim={...claim(original),text:'Last global emoji.',citations:[{messageRevisionId:original.message.id,revisionDigest:original.message.revisionDigest,start:points.length-1,end:points.length}]};
 const end=await runAnalysis({...input(last),reserve:async()=> 'admitted',adapter:withOutput({claims:[endClaim]})});assert.equal(end.checkpoint.state,'complete');assert.equal(end.claims[0].citations[0].text,'😀');
});
test('semantic analysis is disabled without exact identity/privacy/access/consent/budget; uncertain retries never call provider',async()=>{
 const message=await body('request','A cited request.'),chunk=(await planAnalysis(snapshot([message]),[],[],'unicode-v1','extractor-v1')).chunks[0];let calls=0;
 const adapter:HistoryAnalysisAdapter={provider:'synthetic-provider',model:'synthetic-exact-model',async analyze(){calls++;return {provider:this.provider,model:this.model,output:{claims:[claim(message)]},inputTokens:1,outputTokens:1,costDollars:null};}};
 const base:AnalysisRunInput={chunk,policy:null,consent:null,adapter,now,reserve:async()=> 'admitted',verifySupport:async()=>({supported:true,contradictions:[]})};
 assert.equal((await runAnalysis(base)).checkpoint.state,'not_configured');assert.equal(calls,0);
 const policy={id:'analysis' as const,enabled:true,provider:adapter.provider,model:adapter.model,maxCostDollars:1,maxInputBytes:65536,maxOutputTokens:1000,timeoutMs:1000},consent={ownerId:owner,provider:adapter.provider,model:adapter.model,sourceIds:['source'],privacyScope:'selected_history' as const,expiresAt:'2027-01-01T00:00:00.000Z',renewableAccess:true};
 for(const patch of [{consent:{...consent,ownerId:'foreign'}},{consent:{...consent,renewableAccess:false}},{policy:{...policy,model:'different'}},{policy:{...policy,maxCostDollars:null}}]){assert.equal((await runAnalysis({...base,policy,consent,...patch})).checkpoint.state,'not_configured');}
 const budget=await runAnalysis({...base,policy,consent,reserve:async()=> 'budget_exhausted'});assert.equal(budget.checkpoint.state,'budget_exhausted');
 assert.equal((await runAnalysis({...base,policy,consent,reserve:async()=> 'uncertain'})).checkpoint.state,'unavailable');assert.equal(calls,0);
 const success=await runAnalysis({...base,policy,consent});assert.equal(success.checkpoint.state,'complete');assert.equal(success.claims.length,1);assert.equal(success.usage!.costDollars,null);assert.equal(calls,1);
 const invalid=await runAnalysis({...base,policy,consent,adapter:{...adapter,async analyze(){return {provider:adapter.provider,model:adapter.model,output:{claims:[{...claim(message),accepted:true}]},inputTokens:1,outputTokens:1,costDollars:0};}}});assert.equal(invalid.checkpoint.state,'invalid_result');assert.equal(invalid.claims.length,0);
 const controller=new AbortController();controller.abort();assert.equal((await runAnalysis({...base,policy,consent,signal:controller.signal})).checkpoint.state,'cancelled');assert.equal(calls,1);
 const mismatched=await runAnalysis({...base,policy,consent,adapter:{...adapter,async analyze(){return {provider:adapter.provider,model:'substituted',output:{claims:[]},inputTokens:1,outputTokens:1,costDollars:0};}}});assert.equal(mismatched.checkpoint.state,'invalid_result');
 const modified=await runAnalysis({...base,policy,consent,chunk:{...chunk,snapshot:{...chunk.snapshot,sourceWatermark:'modified'}}});assert.equal(modified.checkpoint.state,'invalid_result');assert.equal(calls,1);
 assert.equal((await runAnalysis({...base,policy,consent,chunk:{...chunk,messageRevisionIds:[...chunk.messageRevisionIds,'invented']}})).checkpoint.state,'invalid_result');assert.equal(calls,1);
 assert.equal((await runAnalysis({...base,policy,consent,reserve:async()=>{throw Error('private database outage');}})).checkpoint.state,'unavailable');assert.equal(calls,1);
 const offline=await runAnalysis({...base,policy,consent,adapter:{...adapter,async analyze(){throw Error('Private provider transport failure.');}}});assert.equal(offline.checkpoint.state,'unavailable');assert.ok(!JSON.stringify(offline).includes('Private provider transport failure'));
 assert.equal((await runAnalysis({...base,policy,consent,reserve:async()=> 'replayed'})).checkpoint.state,'unavailable');assert.equal(calls,1);
 // An adapter ignoring abort cannot hold the caller indefinitely or cause a retry.
 const timer=setTimeout(()=>{},1000);
 try{const timed=await runAnalysis({...base,policy:{...policy,timeoutMs:10},consent,adapter:{...adapter,analyze:async()=>new Promise(()=>{})}});assert.equal(timed.checkpoint.state,'cancelled');assert.match(timed.diagnostics[0],/uncertain/);}finally{clearTimeout(timer);}
});
test('bounded retained work context and closed operation proposals carry no model authority or operation IDs',async()=>{
 const input=snapshot([await body('continuation','Cancel the previously requested synthetic harness.')]),item={id:'stable-work',title:'Synthetic prior request',state:'open' as const,workType:'implementation' as const,disposition:'requested' as const,claimIds:['prior-claim']};
 const plan=await planAnalysis(input,[],[],'unicode-v1','extractor-v1',()=>false,{workItems:[item]});assert.deepEqual(plan.chunks[0].providerInput.workItems,[item]);
 const adapter:HistoryAnalysisAdapter={provider:'synthetic-provider',model:'synthetic-model',async analyze(){return {provider:this.provider,model:this.model,output:{claims:[],operations:[{kind:'cancel',workItemId:'stable-work',claimIds:['new-claim']}]},inputTokens:1,outputTokens:1,costDollars:0};}};
 const policy={id:'analysis' as const,enabled:true,provider:adapter.provider,model:adapter.model,maxCostDollars:1,maxInputBytes:65536,maxOutputTokens:1000,timeoutMs:1000},consent={ownerId:owner,provider:adapter.provider,model:adapter.model,sourceIds:['source'],privacyScope:'selected_history' as const,expiresAt:'2027-01-01T00:00:00.000Z',renewableAccess:true};
 const result=await runAnalysis({chunk:plan.chunks[0],policy,consent,adapter,now,reserve:async()=> 'admitted',verifySupport:async()=>({supported:true,contradictions:[]})});assert.equal(result.checkpoint.state,'complete');assert.deepEqual(result.operations,[{kind:'cancel',workItemId:'stable-work',claimIds:['new-claim']}]);assert.equal('operationId'in result.operations[0],false);
 const oversized=await planAnalysis(input,[],[],'unicode-v1','extractor-v1',()=>false,{workItems:[{...item,title:'x'.repeat(100000)}]});assert.deepEqual(oversized.chunks[0].providerInput.workItems,[]);assert.ok(oversized.unknowns.length);assert.ok(Buffer.byteLength(JSON.stringify(oversized.chunks[0].providerInput))<65536);
});
test('native completed conversation chunks retain immutable identity when a new chat changes global watermark',async()=>{
 const original=await body('original','Original request.','user','old-chat'),later=await body('later','Unrelated later request.','user','new-chat'),before=snapshot([original]);
 const first=(await planAnalysis(before,[],[],'unicode-v1','extractor-v1')).chunks[0],checkpoint={id:'analysis:'+first.inputDigest,sourceWatermark:before.sourceWatermark,inputDigest:first.inputDigest,normalizationVersion:'unicode-v1',extractorVersion:'extractor-v1',processedMessageRevisionIds:first.messageRevisionIds,processedSegmentIds:[],affectedAreaIds:[],state:'complete' as const};
 const after={...snapshot([original,later]),sourceWatermark:'new-semantic-watermark'},plan=await planAnalysis(after,[],[checkpoint],'unicode-v1','extractor-v1',()=>true);
 assert.deepEqual(plan.chunks.flatMap(chunk=>chunk.messageRevisionIds),['later']);assert.ok(plan.completedMessageRevisionIds.includes('original'));
 assert.equal((await planAnalysis(after,[],[checkpoint],'unicode-v1','extractor-v1',()=>false)).chunks.length,2);
 const changed={...after,contexts:after.contexts.map(context=>context.messageRevisionId==='original'?{...context,branch:'changed'}:context)};
 assert.equal((await planAnalysis(changed,[],[checkpoint],'unicode-v1','extractor-v1',()=>true)).chunks.length,2);
});
test('private extraction proof skips old text despite changed work state while request digests bind actual context',async()=>{
 const old=await body('old-request','Old physical acceptance request.','user','z-old'),added=await body('new-request','New continuation.','user','a-new'),item={id:'stable-work',title:'Physical acceptance loop',state:'open' as const,workType:'testing' as const,disposition:'requested' as const,claimIds:['old-claim']};
 const first=(await planAnalysis(snapshot([old]),[],[],'unicode-v1','extractor-v1',()=>false,{workItems:[item]})).chunks[0];
 const changed=(await planAnalysis({...snapshot([old]),sourceWatermark:'later'},[],[],'unicode-v1','extractor-v1',()=>false,{workItems:[{...item,state:'cancelled'}]})).chunks[0];assert.equal(first.extractionDigest,changed.extractionDigest);assert.notEqual(first.inputDigest,changed.inputDigest);
 const after=await planAnalysis({...snapshot([old,added]),sourceWatermark:'later'},[],[],'unicode-v1','extractor-v1',()=>false,{workItems:[{...item,state:'cancelled'}],trustedExtractionDigests:[first.extractionDigest]});assert.deepEqual(after.chunks.flatMap(chunk=>chunk.messageRevisionIds),['new-request']);assert.equal(after.chunks[0].providerInput.workItems?.[0].state,'cancelled');
 const associationChanged={...snapshot([old]),associations:[{messageRevisionId:old.message.id,projectId:'different-project',areaId:null}]};assert.equal((await planAnalysis(associationChanged,[],[],'unicode-v1','extractor-v1',()=>false,{trustedExtractionDigests:[first.extractionDigest]})).chunks.length,1);
});
