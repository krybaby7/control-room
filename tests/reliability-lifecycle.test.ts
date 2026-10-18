import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, getBlockers } from '../lib/planning.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
const at = '2026-10-17T12:00:00.000Z';
test('archive and restore preserve completed history and fulfilled prerequisites', () => {
  let workspace = createSeedWorkspace(at);
  const a = workspace.tasks[0];
  workspace = applyCommand(workspace, { type: 'task.update', id: a.id, patch: { status: 'done' } }, at);
  const dependent = workspace.tasks.find(t => t.dependsOn.includes(a.id))!;
  workspace = applyCommand(workspace, { type: 'task.update', id: dependent.id, patch: { status: 'done' } }, at);
  workspace = applyCommand(workspace, { type: 'task.update', id: a.id, patch: { status: 'archived' } }, '2026-10-18T12:00:00.000Z');
  assert.equal(workspace.tasks[0].completedAt, at);
  assert.deepEqual(getBlockers(workspace.tasks.find(t => t.id === dependent.id)!, workspace), []);
  assert.throws(() => applyCommand(workspace, { type: 'task.update', id: a.id, patch: { status: 'todo' } }, at), /dependent|blocked/);
  workspace = applyCommand(workspace, { type: 'task.restore', id: a.id }, '2026-10-19T12:00:00.000Z');
  assert.equal(workspace.tasks[0].status, 'done');
  assert.equal(workspace.tasks[0].completedAt, at);
  assert.throws(() => applyCommand(workspace, { type: 'task.update', id: a.id, patch: { status: 'todo' } }, at), /dependent|blocked/);
});

test('archive restores each original active status without inventing a completion', () => {
  for (const status of ['proposed','todo','doing','review'] as const) {
    let workspace = createSeedWorkspace(at); const id = workspace.tasks[0].id;
    workspace = applyCommand(workspace, { type:'task.update',id,patch:{status} },at);
    workspace = applyCommand(workspace, { type:'task.update',id,patch:{status:'archived'} },at);
    workspace = applyCommand(workspace, { type:'task.restore',id },at);
    assert.equal(workspace.tasks[0].status,status);
    assert.equal(workspace.tasks[0].completedAt,null);
  }
});
