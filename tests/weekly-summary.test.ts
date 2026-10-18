import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand } from '../lib/planning.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { weeklyCompletionCount } from '../lib/weekly-summary.ts';

const at = '2026-10-17T12:00:00.000Z';

test('this week completion count survives archive and restore, excludes reopened work', () => {
  let workspace = createSeedWorkspace(at);
  const id = workspace.tasks[0].id;
  workspace = applyCommand(workspace, { type: 'task.update', id, patch: { status: 'done', weekly: true } }, at);
  assert.equal(weeklyCompletionCount(workspace.tasks, at), 1);
  workspace = applyCommand(workspace, { type: 'task.update', id, patch: { status: 'archived' } }, at);
  assert.equal(weeklyCompletionCount(workspace.tasks, at), 1);
  workspace = applyCommand(workspace, { type: 'task.restore', id }, at);
  assert.equal(weeklyCompletionCount(workspace.tasks, at), 1);
  workspace = applyCommand(workspace, { type: 'task.update', id, patch: { status: 'todo' } }, at);
  assert.equal(weeklyCompletionCount(workspace.tasks, at), 0);
});

test('this week completions include unpinned work and exclude historical completed work', () => {
  let workspace = createSeedWorkspace(at);
  const id = workspace.tasks[0].id;
  workspace = applyCommand(workspace, { type: 'task.update', id, patch: { status: 'done' } }, at);
  assert.equal(weeklyCompletionCount(workspace.tasks, at), 1);
  assert.equal(weeklyCompletionCount(workspace.tasks, '2026-10-19'), 0);
});
