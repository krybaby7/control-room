import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecurrenceRule,enumerateOccurrences,nextTenOccurrences,occurrenceTaskId,createRecurrenceProposal,type RecurrenceRule} from '../lib/recurrence.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parsePlanningImport} from '../lib/workspace-codec.ts';
const now='2026-10-18T12:00:00.000Z';const workspace=parsePlanningImport(createSeedWorkspace(now));
const rule:RecurrenceRule={id:'bb089a3a-0147-46f4-bd98-8a9b2118cedd',startDate:'2026-01-01',endDate:null,enabled:true,pattern:{frequency:'daily',interval:2},template:{estimateMinutes:30,projectId:workspace.projects[0].id,milestoneId:workspace.milestones[0].id,title:'Recurring review',notes:'Review evidence',horizon:'next',priority:'normal',blocker:'',sourceUrl:'https://example.com/source'}};
test('daily inclusive anchors, bounded end and paused rules',()=>{
 assert.deepEqual(enumerateOccurrences(rule,'2026-01-01','2026-01-08'),['2026-01-01','2026-01-03','2026-01-05','2026-01-07']);assert.deepEqual(enumerateOccurrences({...rule,endDate:'2026-01-05'},'2026-01-01','2026-01-08'),['2026-01-01','2026-01-03','2026-01-05']);assert.deepEqual(enumerateOccurrences({...rule,enabled:false},'2026-01-01','2026-01-08'),[]);assert.deepEqual(enumerateOccurrences(rule,'2025-12-29','2026-01-01'),['2026-01-01']);assert.equal(nextTenOccurrences({...rule,pattern:{frequency:'daily',interval:1}},'2026-01-01','2026-03-31').length,10);
});
test('weekly Monday/Thursday across year boundary and two-week ISO week anchors',()=>{
 const weekly={...rule,startDate:'2025-12-29',pattern:{frequency:'weekly' as const,interval:1,weekdays:[1,4]}};assert.deepEqual(enumerateOccurrences(weekly,'2025-12-29','2026-01-09'),['2025-12-29','2026-01-01','2026-01-05','2026-01-08']);assert.deepEqual(enumerateOccurrences({...weekly,startDate:'2025-12-31',pattern:{...weekly.pattern,interval:2}},'2025-12-29','2026-01-15'),['2026-01-01','2026-01-12','2026-01-15']);
});
test('monthly preserves January 31 anchor through ordinary/leap February and yearly intervals',()=>{
 const monthly={...rule,startDate:'2025-01-31',pattern:{frequency:'monthly' as const,interval:1,day:31}};assert.deepEqual(enumerateOccurrences(monthly,'2025-01-01','2025-03-31'),['2025-01-31','2025-02-28','2025-03-31']);assert.deepEqual(enumerateOccurrences({...monthly,startDate:'2024-01-31'},'2024-01-02','2024-03-31'),['2024-01-31','2024-02-29','2024-03-31']);assert.deepEqual(enumerateOccurrences({...monthly,startDate:'2024-02-29',pattern:{frequency:'monthly',interval:12,day:29}},'2025-02-01','2025-03-01'),['2025-02-28']);
});
test('Cairo midnight DST dates remain unique ordinary calendar dates',()=>{
 const daily={...rule,startDate:'2026-04-22',pattern:{frequency:'daily' as const,interval:1}};assert.deepEqual(enumerateOccurrences(daily,'2026-04-22','2026-04-26'),['2026-04-22','2026-04-23','2026-04-24','2026-04-25','2026-04-26']);assert.deepEqual(enumerateOccurrences(daily,'2026-10-28','2026-10-31'),['2026-10-28','2026-10-29','2026-10-30','2026-10-31']);
});
test('strict patterns, real dates, exact range bounds and saved identity reject invalid values',()=>{
 for(const patch of [{pattern:{frequency:'daily',interval:0}},{pattern:{frequency:'daily',interval:366}},{pattern:{frequency:'daily',interval:1.5}},{pattern:{frequency:'weekly',interval:1,weekdays:[1,1]}},{pattern:{frequency:'weekly',interval:1,weekdays:[0]}},{pattern:{frequency:'monthly',interval:1,day:32}},{endDate:'2025-12-31'},{startDate:'2026-02-29'},{id:'x'.repeat(36)},{credentials:'private'},{template:{...rule.template,status:'done'}},{template:{...rule.template,sourceUrl:'https://user:password@example.com'}}])assert.throws(()=>parseRecurrenceRule({...rule,...patch}));
 assert.throws(()=>enumerateOccurrences(rule,'2026-01-01','2026-04-01'),/ninety/);assert.throws(()=>enumerateOccurrences(rule,'2026-01-02','2026-01-01'));assert.throws(()=>enumerateOccurrences(rule,'2026-02-30','2026-03-01'));assert.throws(()=>occurrenceTaskId(rule.id,'2026-02-30'));assert.throws(()=>occurrenceTaskId('------------------------------------','2026-01-01'));assert.equal(occurrenceTaskId(rule.id,'2026-01-01'),`repeat:${rule.id}:2026-01-01`);
});
test('proposal is always proposed unpinned empty evidence/dependencies; archived targets need attention without mutations',()=>{
 const original=structuredClone(workspace);const result=createRecurrenceProposal(rule,'2026-01-03',workspace,now);assert.equal(result.status,'proposed');if(result.status!=='proposed')return;assert.equal(result.task.status,'proposed');assert.equal(result.task.weekly,false);assert.equal(result.task.dueDate,'2026-01-03');assert.deepEqual(result.task.dependsOn,[]);assert.equal(result.task.evidence,'');assert.equal(result.task.completedAt,null);assert.equal(result.task.sourceUrl,rule.template.sourceUrl);assert.equal(result.task.milestoneId,rule.template.milestoneId);assert.equal(createRecurrenceProposal(rule,'2026-01-02',workspace,now).status,'not-due');
 assert.deepEqual(createRecurrenceProposal({...rule,enabled:false},'2026-01-03',workspace,now),{status:'attention',reason:'paused-rule'});const projectArchived=structuredClone(workspace);projectArchived.projects[0].archivedAt=now;assert.deepEqual(createRecurrenceProposal(rule,'2026-01-03',projectArchived,now),{status:'attention',reason:'archived-project'});const milestoneArchived=structuredClone(workspace);milestoneArchived.milestones[0].archivedAt=now;assert.deepEqual(createRecurrenceProposal(rule,'2026-01-03',milestoneArchived,now),{status:'attention',reason:'archived-milestone'});assert.deepEqual(workspace,original);
});

test('next ten selector jumps monthly periods beyond the ninety-day preview without losing the anchor',()=>{
 const monthly={...rule,startDate:'2026-01-31',pattern:{frequency:'monthly' as const,interval:1,day:31}};const dates=nextTenOccurrences(monthly,'2026-01-31');assert.equal(dates.length,10);assert.deepEqual(dates.slice(0,3),['2026-01-31','2026-02-28','2026-03-31']);assert.equal(dates[9],'2026-10-31');assert.deepEqual(nextTenOccurrences({...monthly,endDate:'2026-02-28'},'2026-01-31'),['2026-01-31','2026-02-28']);
});
