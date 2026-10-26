import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProjectBriefing,previousLedger} from '../shared/project-briefing.mjs';
import {briefingFixture,briefingFixtureV3,briefingFixtureV1,briefingFixtureV2} from './fixtures/briefing.ts';

test('every historical report projects purely to version 4 with honest folder coverage',()=>{
 const v3=briefingFixtureV3();
 for(const legacy of [briefingFixtureV1(),briefingFixtureV2(),v3]){
  const before=JSON.stringify(legacy),report=validateProjectBriefing(legacy);
  assert.equal(report.version,4);assert.equal(JSON.stringify(legacy),before);
  assert.deepEqual(report.repositories,[legacy.repository]);
  assert.equal(report.evidence.repositories[0].key,legacy.repository.key);
  assert.equal(report.evidence.repositories[0].local.commits,legacy.evidence.local.commits);
  assert.deepEqual(validateProjectBriefing(report),report);
 }
});
test('multi-folder reports bind coverage and references to selected folders',()=>{
 const report=validateProjectBriefing(briefingFixture());
 const second={...report.repository,key:'map-lab',name:'Map lab'};
 report.repositories.push(second);report.evidence.repositories.push({...structuredClone(report.evidence.repositories[0]),key:second.key,name:second.name});
 report.areas[0].repositoryKey='map-lab';report.intentions[0].repositoryKey='map-lab';report.intentions[0].evidence=[{repositoryKey:'map-lab',ref:'PR #12'}];
 assert.deepEqual(validateProjectBriefing(report),report);
 assert.equal(previousLedger(report).areas[0].repositoryKey,'map-lab');
 const badRef=structuredClone(report);badRef.intentions[0].evidence=[{repositoryKey:'unknown',ref:'PR #12'}];assert.throws(()=>validateProjectBriefing(badRef));
 for(const edit of [(v:typeof report)=>{v.areas[0].repositoryKey='unknown';},(v:typeof report)=>{v.intentions[0].repositoryKey='unknown';},(v:typeof report)=>{v.evidence.repositories.pop();},(v:typeof report)=>{v.repositories.push(v.repositories[0]);},(v:typeof report)=>{v.evidence.repositories[0].name='spoof';}]){const bad=structuredClone(report);edit(bad);assert.throws(()=>validateProjectBriefing(bad));}
});

test('historical v3 remains strict and v4 admits no more than four folders',()=>{
 const historical=briefingFixtureV3();historical.areas[0].repositoryKey=historical.repository.key;assert.throws(()=>validateProjectBriefing(historical));
 const report=briefingFixture();for(let i=1;i<5;i++){const repository={...report.repository,key:`folder-${i}`};report.repositories.push(repository);report.evidence.repositories.push({...structuredClone(report.evidence.repositories[0]),key:repository.key});}
 assert.throws(()=>validateProjectBriefing(report));report.repositories.pop();report.evidence.repositories.pop();assert.equal(validateProjectBriefing(report).repositories.length,4);
});
