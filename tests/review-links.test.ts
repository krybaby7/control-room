import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewHref,parseReviewLink,resolveReviewTarget,type ReviewSnapshot,type ReviewTarget} from '../lib/review-links.ts';
import type {EvidenceVersion,DecisionVersion} from '../lib/evidence-contract.ts';
import type {HistoryEntry} from '../lib/history.ts';
const now='2026-10-18T12:00:00.000Z',missing={status:'unavailable'};
function snapshot():ReviewSnapshot{const evidence:EvidenceVersion={id:'legacy:task:a &?ب/#%+',version:1,basis:'owner-statement',scope:'implementation',title:'Original exact evidence',statement:'Original record',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};const decision:DecisionVersion={id:'decision /?مرحبا',version:1,title:'Original decision',question:'Choose?',options:[],selectedOptionId:null,rationale:'',status:'draft',decidedAt:null,reviewOn:null,subjects:[],evidenceRefs:[],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null};return {evidenceHeads:[{id:evidence.id,currentVersion:2,archivedAt:now}],evidenceVersions:[evidence,{...evidence,version:2,supersedesVersion:1,title:'Later evidence'}],decisionHeads:[{id:decision.id,currentVersion:1,archivedAt:null}],decisionVersions:[decision]};}
const event:HistoryEntry={id:'history ?&/ب+#%',workspaceRevision:1,ordinal:0,streamId:null,streamSequence:null,kind:'legacy-note',entityType:'task',entityId:null,occurredAt:now,origin:null,actorId:null,sourceRef:null,undoOf:null,event:null,sourcePayload:{text:'Original legacy history'}};

test('stable review citations preserve exact logical IDs and versions including legacy Unicode and punctuation',()=>{
 for(const target of [{kind:'evidence',id:'legacy:task:a &?ب/#%+',version:1},{kind:'decision',id:'decision /?مرحبا',version:Number.MAX_SAFE_INTEGER},{kind:'history',id:event.id},{kind:'evidence',id:'x'.repeat(128),version:2}] satisfies ReviewTarget[]){const href=reviewHref(target);assert.ok(href.startsWith('/?'));assert.deepEqual(parseReviewLink(href),{status:'valid',target});assert.deepEqual(parseReviewLink(new URLSearchParams(href.slice(2))),{status:'valid',target});assert.deepEqual(parseReviewLink(`https://private.example${href}`,{origin:'https://private.example'}),{status:'valid',target});}
 assert.match(reviewHref({kind:'evidence',id:'x',version:1}),/^\/\?view=evidence&review=evidence&id=x&version=1$/);assert.match(reviewHref({kind:'decision',id:'x',version:1}),/view=evidence&review=decision/);assert.equal(reviewHref({kind:'history',id:'x'}),'/?view=history&review=history&id=x');
});

test('duplicate, unknown, malformed and noncanonical version parameters fail neutrally',()=>{
 const base='/?view=evidence&review=evidence&id=x';for(const version of ['0','-1','+1','01','1.0','1e2','Infinity','NaN','9007199254740992','',' 1','1 '])assert.deepEqual(parseReviewLink(`${base}&version=${encodeURIComponent(version)}`),missing,version);
 for(const query of [`${base}&version=1&version=2`,`${base}&version=1&id=y`,`${base}&version=1&view=evidence`,`${base}&version=1&review=decision`,`${base}&version=1&entity=task`,`${base}&version=1&owner=foreign`,`${base}&version=1&unknown=x`,'/?view=history&review=history&id=x&version=1','/?view=decisions&review=decision&id=x&version=1','/?view=projects&review=evidence&id=x&version=1','/?view=evidence&review=attachment&id=x&version=1','/?view=evidence&review=evidence&id=x','/?review=history&id=x','/?view=history&review=history&id=','/?view=history&review=history&id=%00','/?view=history&review=history&id=%ZZ','/?view=history&review=history&id=%ED%A0%80'])assert.deepEqual(parseReviewLink(query),missing,query);
});

test('unsafe paths, origins, credentials, fragments, controls and lossy Unicode never produce navigation',()=>{
 const href=reviewHref({kind:'evidence',id:'x',version:1});for(const input of [`https://evil.example${href}`,`//evil.example${href}`,`javascript:alert(1)${href}`,`/elsewhere${href.slice(1)}`,`${href}#other`,`https://user:password@private.example${href}`])assert.deepEqual(parseReviewLink(input,{origin:'https://private.example'}),missing,input);
 assert.deepEqual(parseReviewLink(`https://private.example${href}`),missing);assert.deepEqual(parseReviewLink(href,{origin:'https://private.example/path'}),missing);assert.deepEqual(parseReviewLink('x'.repeat(4097)),missing);
 for(const id of ['', ' ', 'x'.repeat(129),'bad\nline','bad\u007f','\ud800','\udfff']){assert.throws(()=>reviewHref({kind:'history',id}));assert.deepEqual(parseReviewLink(`/?view=history&review=history&id=${id}`),missing);}
 for(const version of [0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>reviewHref({kind:'evidence',id:'x',version}));
});

test('owner-supplied snapshot resolves the exact historical version without selecting latest or granting acceptance',()=>{
 const owned=snapshot(),target={kind:'evidence' as const,id:owned.evidenceHeads[0].id,version:1};assert.deepEqual(parseReviewLink(reviewHref(target)),{status:'valid',target});const result=resolveReviewTarget(target,owned);assert.equal(result.status,'available');if(result.status==='available'&&'historical' in result){assert.equal(result.record.title,'Original exact evidence');assert.equal(result.historical,true);assert.equal(result.archived,true);assert.equal(result.record.version,1);}
 const decision={kind:'decision' as const,id:owned.decisionHeads[0].id,version:1};const resolved=resolveReviewTarget(decision,owned);assert.equal(resolved.status,'available');if(resolved.status==='available'&&'historical' in resolved){assert.equal(resolved.historical,false);assert.equal(resolved.archived,false);}
});

test('foreign, missing or ambiguous versions and history entries share neutral unavailable results',()=>{
 const owned=snapshot(),target={kind:'evidence' as const,id:owned.evidenceHeads[0].id,version:1},foreign:ReviewSnapshot={evidenceHeads:[],evidenceVersions:[],decisionHeads:[],decisionVersions:[]};assert.deepEqual(resolveReviewTarget(target,foreign),missing);assert.deepEqual(resolveReviewTarget({...target,version:99},owned),missing);assert.deepEqual(resolveReviewTarget(target,null),missing);assert.deepEqual(resolveReviewTarget(target,{...owned,evidenceHeads:[]}),missing);assert.deepEqual(resolveReviewTarget(target,{...owned,evidenceVersions:[...owned.evidenceVersions,owned.evidenceVersions[0]]}),missing);assert.deepEqual(resolveReviewTarget({...target,id:'missing'},owned),missing);
 const history={kind:'history' as const,id:event.id};assert.deepEqual(resolveReviewTarget(history,null,[event]),{status:'available',target:history,record:event});assert.deepEqual(resolveReviewTarget(history,null,[]),missing);assert.deepEqual(resolveReviewTarget(history,null,[event,event]),missing);assert.deepEqual(resolveReviewTarget({kind:'history',id:'foreign-event'},null,[event]),missing);
});
