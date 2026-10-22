import test from 'node:test';
import assert from 'node:assert/strict';
import {clockLabel,compactNumber,durationLabel,excerpt,percent,relativeTime,secondsBetween} from '../lib/dashboard/format.ts';
const now='2026-10-21T12:00:00.000Z';
test('relative time reads naturally and never invents precision',()=>{
 assert.equal(relativeTime('2026-10-21T11:59:50.000Z',now),'just now');
 assert.equal(relativeTime('2026-10-21T11:56:00.000Z',now),'4 min ago');
 assert.equal(relativeTime('2026-10-21T09:00:00.000Z',now),'3 h ago');
 assert.equal(relativeTime('2026-10-20T06:00:00.000Z',now),'yesterday');
 assert.equal(relativeTime('2026-10-16T12:00:00.000Z',now),'5 d ago');
 assert.equal(relativeTime('2026-09-01T12:00:00.000Z',now),'1 Sept');
 assert.equal(relativeTime('2026-10-21T12:05:00.000Z',now),'ahead of clock');
 assert.equal(relativeTime(null,now),'unknown time');
 assert.equal(relativeTime('not a date',now),'unknown time');
});
test('clock, counts and durations format compactly',()=>{
 assert.equal(clockLabel('2026-10-21T12:07:00.000Z'),'15:07');
 assert.equal(clockLabel(null),'--:--');
 assert.equal(compactNumber(950),'950');assert.equal(compactNumber(12400),'12.4k');assert.equal(compactNumber(3100),'3.1k');assert.equal(compactNumber(250000),'250k');assert.equal(compactNumber(1250000),'1.25M');assert.equal(compactNumber(null),'—');
 assert.equal(durationLabel(45),'45s');assert.equal(durationLabel(75),'1m 15s');assert.equal(durationLabel(3600),'1h 0m');assert.equal(durationLabel(null),'—');assert.equal(durationLabel(-5),'—');
 assert.equal(secondsBetween('2026-10-21T11:55:00.000Z',now),300);assert.equal(secondsBetween(now,'2026-10-21T11:55:00.000Z'),0);assert.equal(secondsBetween(null,now),null);
 assert.equal(percent(3,8),38);assert.equal(percent(0,0),0);assert.equal(percent(9,8),100);
});
test('excerpts cut on a word boundary and strip dangling punctuation',()=>{
 assert.equal(excerpt('  short   text '),'short text');
 const long='The last chats focused on finishing the Android device acceptance matrix, map coverage review and the landmark lab integration contract which is drafted but not accepted yet.';
 const cut=excerpt(long,60);
 assert.ok(cut.endsWith('…'));assert.ok(cut.length<=62);assert.ok(!cut.includes(',…'));
 assert.equal(excerpt(null),'');
});
