import test from 'node:test';
import assert from 'node:assert/strict';
import { changedFields } from '../lib/draft.ts';
import { applyCommand } from '../lib/planning.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import type { TaskInput } from '../lib/types.ts';

const NOW = '2026-10-17T12:00:00.000Z';
const LATER = '2026-10-18T12:00:00.000Z';

function editFixture() {
  const workspace = createSeedWorkspace(NOW);
  const task = workspace.tasks[0];
  const baseline: TaskInput = {
    projectId: task.projectId, milestoneId: task.milestoneId, title: task.title, notes: task.notes,
    status: task.status, horizon: task.horizon, priority: task.priority, dueDate: task.dueDate,
    weekly: task.weekly, dependsOn: [...task.dependsOn], blocker: task.blocker, sourceUrl: task.sourceUrl, evidence: task.evidence, estimateMinutes:task.estimateMinutes,
  };
  return { workspace, task, baseline };
}

test('a retry patch preserves unrelated remote edits including copied dependency arrays', () => {
  const { workspace, task, baseline } = editFixture();
  const draft = { ...baseline, title: 'Locally revised acceptance title', dependsOn: [...baseline.dependsOn] };
  const prerequisite = workspace.tasks.find((candidate) => candidate.projectId === task.projectId && candidate.id !== task.id && candidate.dependsOn.length === 0)!;
  const remote = applyCommand(workspace, { type: 'task.update', id: task.id, patch: { notes: 'New evidence from another session', priority: 'low', dependsOn: [prerequisite.id] } }, LATER);
  const patch = changedFields(baseline, draft);
  assert.deepEqual(patch, { title: 'Locally revised acceptance title' });
  const retried = applyCommand(remote, { type: 'task.update', id: task.id, patch }, LATER);
  const saved = retried.tasks.find((candidate) => candidate.id === task.id)!;
  assert.equal(saved.title, draft.title);
  assert.equal(saved.notes, 'New evidence from another session');
  assert.equal(saved.priority, 'low');
  assert.deepEqual(saved.dependsOn, [prerequisite.id]);
});

test('an intentional same-field edit remains in the retry patch after a remote edit', () => {
  const { workspace, task, baseline } = editFixture();
  const draft = { ...baseline, notes: 'My intentional replacement after reviewing the conflict' };
  const remote = applyCommand(workspace, { type: 'task.update', id: task.id, patch: { notes: 'Remote note', dueDate: '2026-10-23' } }, LATER);
  const patch = changedFields(baseline, draft);
  assert.deepEqual(patch, { notes: draft.notes });
  const retried = applyCommand(remote, { type: 'task.update', id: task.id, patch }, LATER);
  const saved = retried.tasks.find((candidate) => candidate.id === task.id)!;
  assert.equal(saved.notes, draft.notes);
  assert.equal(saved.dueDate, '2026-10-23');
});

test('fields reverted to the opening value and value-equal arrays are omitted', () => {
  const baseline = { title: 'Opening title', dependsOn: ['a', 'b'], dueDate: null as string | null, weekly: false };
  const draft = { ...baseline, title: 'Temporary title', dependsOn: [...baseline.dependsOn], dueDate: '2026-10-20' };
  draft.title = baseline.title;
  const patch = changedFields(baseline, draft);
  assert.deepEqual(patch, { dueDate: '2026-10-20' });
  assert.deepEqual(baseline.dependsOn, ['a', 'b']);
  assert.deepEqual(draft.dependsOn, ['a', 'b']);
});

test('changed array values, removals and primitive changes are preserved without mutating inputs', () => {
  const baseline = { dependsOn: ['a', 'b'], weekly: false, dueDate: '2026-10-20' as string | null };
  const draft = { dependsOn: ['a'], weekly: true, dueDate: null };
  const originalBaseline = structuredClone(baseline);
  const originalDraft = structuredClone(draft);
  assert.deepEqual(changedFields(baseline, draft), { dependsOn: ['a'], weekly: true, dueDate: null });
  assert.deepEqual(baseline, originalBaseline);
  assert.deepEqual(draft, originalDraft);
  assert.deepEqual(changedFields({ dependsOn: ['a', 'b'] }, { dependsOn: ['b', 'a'] }), { dependsOn: ['b', 'a'] });
});
