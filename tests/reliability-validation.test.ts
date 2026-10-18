import { legacyWorkspaceFixture } from './helpers/workspace.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as calendar from '../lib/calendar.ts';
import { parseWorkspaceExport } from '../lib/workspace-validation.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { applyCommand } from '../lib/planning.ts';
const at = '2026-10-17T12:00:00.000Z';
test('Cairo Monday rollover and dated completions use Cairo local date', () => {
  assert.equal(calendar.currentWeek('2026-10-18T20:59:59.000Z'), '2026-10-12');
  assert.equal(calendar.currentWeek('2026-10-18T21:00:00.000Z'), '2026-10-19');
  assert.deepEqual(calendar.weekRange('2026-10-19'), { start: '2026-10-19', end: '2026-10-25' });
  assert.equal(calendar.isCompletedThisWeek({ completedAt: '2026-10-18T21:01:00Z' }, '2026-10-19'), true);
  assert.equal(calendar.isCompletedThisWeek({ completedAt: at }, '2026-10-19'), false);
});
test('legacy pins use last saved week and retain all content; future schemas fail', () => {
  const old = legacyWorkspaceFixture(1,at); old.tasks[0].weekly = true;
  const migrated = parseWorkspaceExport({ workspace: old, updatedAt: at, revision: 8 });
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.tasks[0].weeklyWeek, '2026-10-12');
  assert.equal(calendar.isCurrentWeek(migrated.tasks[0], '2026-10-19'), false);
  assert.equal(migrated.tasks[0].notes, old.tasks[0].notes);
  assert.throws(() => parseWorkspaceExport({ ...old, schemaVersion: 999 }), /version/i);
});
test('weekly carry-forward is explicit and unrelated edits preserve prior week', () => {
  let ws = createSeedWorkspace(at); const id = ws.tasks[0].id;
  ws = applyCommand(ws, { type: 'task.update', id, patch: { weekly:true } }, at);
  ws = applyCommand(ws, { type: 'task.update', id, patch: { notes:'Unrelated update' } }, '2026-10-19T12:00:00Z');
  assert.equal(ws.tasks[0].weeklyWeek,'2026-10-12');
  assert.equal(calendar.isCurrentWeek(ws.tasks[0],'2026-10-19'),false);
  ws = applyCommand(ws, { type: 'task.update', id, patch: { weekly:true } }, '2026-10-19T12:00:00Z');
  assert.equal(ws.tasks[0].weeklyWeek,'2026-10-19');
});
test('restore rejects invalid references, cycles, duplicates, timestamps, URLs and count overflow', () => {
  const original = createSeedWorkspace(at);
  for (const mutate of [
    (w: typeof original) => { w.tasks[0].milestoneId = 'foreign'; },
    (w: typeof original) => { w.tasks[0].dependsOn = [w.tasks[0].id]; },
    (w: typeof original) => { w.tasks[1].id = w.tasks[0].id; },
    (w: typeof original) => { w.tasks[0].createdAt = 'tomorrow'; },
    (w: typeof original) => { w.tasks[0].dueDate = '2026-02-31'; },
    (w: typeof original) => { w.tasks[0].sourceUrl = 'javascript:alert(1)'; },
    (w: typeof original) => { w.tasks[0].notes = 'x'.repeat(10001); },
    (w: typeof original) => { w.tasks[0].completedAt = at; },
    (w: typeof original) => { w.tasks[0].status = 'done'; },
    (w: typeof original) => { Object.assign(w,{unknownField:'do not silently discard'}); },
    (w: typeof original) => { w.tasks = Array.from({ length: 2001 }, (_, i) => ({ ...w.tasks[0], id: String(i) })); },
  ]) { const bad = structuredClone(original); mutate(bad); assert.throws(() => parseWorkspaceExport({workspace:bad,updatedAt:at})); }
});

test('large valid workspace exports survive formatted export, strict preview and JSON roundtrip', () => {
  const workspace = createSeedWorkspace(at);
  const template = workspace.tasks[0];
  workspace.tasks.push(...Array.from({length:95},(_,i) => ({...template,id:`large-${i}`,notes:'x'.repeat(9800)})));
  const envelope = {workspace,revision:9,updatedAt:at,exportedAt:at};
  assert.ok(new TextEncoder().encode(JSON.stringify(workspace)).byteLength > 900000);
  assert.ok(new TextEncoder().encode(JSON.stringify(workspace)).byteLength < 1000000);
  assert.deepEqual(parseWorkspaceExport(JSON.parse(JSON.stringify(envelope,null,2))),{...workspace,schemaVersion:4});
});
