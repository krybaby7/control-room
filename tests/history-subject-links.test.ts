import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historySubjectHref,parseHistorySubjectLink} from '../lib/history-subject-links.ts';
import {resolveEvidenceSubject} from '../lib/evidence-subject-links.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
test('history filter intent preserves literal original IDs and never adds owner or undo authority',()=>{
 for(const id of ['ملف / A & B?=# +é','legacy:milestone:original','x'.repeat(128)]) {
  const subject={type:'milestone' as const,id},href=historySubjectHref(subject),params=new URLSearchParams(href.slice(2));
  assert.equal(params.get('view'),'history');assert.deepEqual([...params.keys()],['view','subject','id']);
  assert.deepEqual(parseHistorySubjectLink(params),{status:'valid',target:subject});assert.equal(params.get('view'),'history','parser cannot mutate caller navigation');
 }
});
test('duplicate scope, unknown filters, control IDs and wrong views are unavailable rather than broad history',()=>{
 for(const query of [
  'view=history&view=history&subject=milestone&id=a','view=history&subject=milestone&id=a&id=b',
  'view=history&subject=milestone&subject=task&id=a','view=history&subject=milestone&id=a&owner=foreign',
  'view=history&subject=milestone&id=a&entityId=other','view=evidence&subject=milestone&id=a',
  'view=history&subject=other&id=a','view=history&subject=milestone','view=history&subject=milestone&id=%00'
 ])assert.deepEqual(parseHistorySubjectLink(new URLSearchParams(query)),{status:'unavailable'});
 assert.throws(()=>historySubjectHref({type:'milestone',id:' padded'}));
});
test('owner resolution retains archived milestone history and neutrally rejects missing or foreign IDs',()=>{
 const workspace=createSeedWorkspace('2026-10-18T12:00:00.000Z'),milestone=workspace.milestones[0];milestone.archivedAt='2026-10-18T12:00:00.000Z';
 const parsed=parseHistorySubjectLink(new URLSearchParams(historySubjectHref({type:'milestone',id:milestone.id}).slice(2)));assert.ok(parsed.status==='valid');
 assert.deepEqual(resolveEvidenceSubject(workspace,parsed.target),{status:'available',subject:parsed.target,archived:true});
 assert.deepEqual(resolveEvidenceSubject(workspace,{type:'milestone',id:'foreign-original'}),{status:'unavailable'});
});
