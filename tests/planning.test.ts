import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, getBlockers, getRecommendations } from '../lib/planning.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { projectFixture, taskInputFixture, taskFixture, milestoneFixture } from './helpers/workspace.ts';
import type { Workspace, Task, TaskInput, CaptureInput, MilestoneInput } from '../lib/types.ts';

const NOW = '2026-10-17T12:00:00.000Z';
const LATER = '2026-10-18T12:00:00.000Z';

function workspace(): Workspace {
  return { schemaVersion: 4, projects: [
    projectFixture({ id: 'p1', name: 'TAMENNI' }),
    projectFixture({ id: 'p2', name: 'Trade Graph', color: 'teal' }),
  ], milestones: [], tasks: [], captures: [], activity: [] };
}
function input(patch: Partial<TaskInput> = {}): TaskInput {
  return taskInputFixture(patch);
}
function task(id: string, patch: Partial<TaskInput> = {}): Task {
  return taskFixture(id, { ...patch, createdAt: NOW, updatedAt: NOW });
}
function capture(patch: Partial<CaptureInput> = {}): CaptureInput {
  return { title: 'An operating criterion', body: 'Keep this complete source text.', projectId: 'p1', kind: 'idea', sourceUrl: 'https://example.com/evidence', ...patch };
}
function milestone(patch: Partial<MilestoneInput> = {}): MilestoneInput {
  return { projectId: 'p1', title: 'Accepted operation', description: '', acceptance: 'A reproducible full cycle.', status: 'planned', targetDate: null, evidence: '', ...patch };
}

test('creating a task normalizes text and returns a new state without mutating the source', () => {
  const original = workspace();
  const next = applyCommand(original, { type: 'task.create', task: input({ title: '  Check map coverage  ' }) }, NOW);
  assert.equal(original.tasks.length, 0);
  assert.equal(original.activity.length, 0);
  assert.equal(next.tasks[0].title, 'Check map coverage');
  assert.match(next.tasks[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(next.tasks[0].createdAt, NOW);
  assert.equal(next.activity.length, 1);
});

test('unknown commands, unknown fields and invalid values are rejected with useful messages', () => {
  for (const [command, message] of [
    [null, /command/i],
    [{ type: 'delete.everything' }, /unknown command/i],
    [{ type: 'task.create', task: input({ title: '' }) }, /title/i],
    [{ type: 'task.create', task: input({ title: 'a'.repeat(201) }) }, /title/i],
    [{ type: 'task.create', task: input({ weekly: 'yes' as never }) }, /weekly/i],
    [{ type: 'task.create', task: input({ status: 'shipped' as never }) }, /status/i],
    [{ type: 'task.create', task: { ...input(), id: 'client-id' } }, /field/i],
    [{ type: 'task.create', task: input({ projectId: 'foreign' }) }, /project/i],
    [{ type: 'task.create', task: input({ dependsOn: 'a' as never }) }, /dependencies/i],
  ] as const) assert.throws(() => applyCommand(workspace(), command, NOW), message);
});

test('dates must be actual calendar dates and source URLs must be HTTP or HTTPS', () => {
  for (const dueDate of ['2026-02-29', '2026-13-01', '17/10/2026', '2026-02-31']) {
    assert.throws(() => applyCommand(workspace(), { type: 'task.create', task: input({ dueDate }) }, NOW), /date/i);
  }
  const leap = applyCommand(workspace(), { type: 'task.create', task: input({ dueDate: '2028-02-29' }) }, NOW);
  assert.equal(leap.tasks[0].dueDate, '2028-02-29');
  for (const sourceUrl of ['javascript:alert(1)', 'file:///private/file', 'not a URL']) {
    assert.throws(() => applyCommand(workspace(), { type: 'capture.create', capture: capture({ sourceUrl }) }, NOW), /url|https/i);
  }
});

test('milestone references must exist and belong to the task project', () => {
  const original = workspace();
  original.milestones = [milestoneFixture({ ...milestone({ projectId: 'p2' }), id: 'm2', updatedAt: NOW })];
  for (const milestoneId of ['missing', 'm2']) {
    assert.throws(() => applyCommand(original, { type: 'task.create', task: input({ milestoneId }) }, NOW), /milestone/i);
  }
});

test('missing, foreign, self and cyclic dependencies are rejected without mutation', () => {
  const original = workspace();
  original.tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('foreign', { projectId: 'p2' })];
  const before = structuredClone(original);
  for (const dependsOn of [['missing'], ['foreign'], ['a'], ['b']]) {
    assert.throws(() => applyCommand(original, { type: 'task.update', id: 'a', patch: { dependsOn } }, NOW), /depend|cycle/i);
    assert.deepEqual(original, before);
  }
});

test('duplicate dependency references are rejected', () => {
  const original = workspace();
  original.tasks = [task('a')];
  assert.throws(() => applyCommand(original, { type: 'task.create', task: input({ dependsOn: ['a', 'a'] }) }, NOW), /duplicate|once/i);
});

test('blockers describe explicit blocks and unfinished or archived dependencies', () => {
  const original = workspace();
  original.tasks = [task('a', { title: 'Device acceptance' }), task('b', { title: 'Old coverage', status: 'archived' }), task('c', { status: 'done' })];
  const blocks = getBlockers(task('d', { blocker: 'Waiting for a test device', dependsOn: ['a', 'b', 'c', 'missing'] }), original);
  assert.equal(blocks.length, 4);
  assert.ok(blocks.some((text) => /Waiting for a test device/.test(text)));
  assert.ok(blocks.some((text) => /Device acceptance/.test(text)));
  assert.ok(blocks.some((text) => /archived/i.test(text)));
  assert.ok(blocks.some((text) => /missing|unavailable/i.test(text)));
});

test('completion is refused until dependencies are done and the explicit block is cleared', () => {
  const original = workspace();
  original.tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { blocker: 'Need acceptance' })];
  for (const id of ['b', 'c']) assert.throws(() => applyCommand(original, { type: 'task.update', id, patch: { status: 'done' } }, NOW), /complet|block/i);
  const oneDone = applyCommand(original, { type: 'task.update', id: 'a', patch: { status: 'done' } }, NOW);
  const bothDone = applyCommand(oneDone, { type: 'task.update', id: 'b', patch: { status: 'done' } }, LATER);
  assert.equal(bothDone.tasks[1].completedAt, LATER);
});

test('a newly created done task also obeys blockers and records completion time', () => {
  assert.throws(() => applyCommand(workspace(), { type: 'task.create', task: input({ status: 'done', blocker: 'Waiting' }) }, NOW), /complet|block/i);
  const next = applyCommand(workspace(), { type: 'task.create', task: input({ status: 'done' }) }, NOW);
  assert.equal(next.tasks[0].completedAt, NOW);
});

test('editing a done task preserves its completion date and reopening clears it', () => {
  const original = workspace();
  original.tasks = [task('a', { status: 'done' })];
  const edited = applyCommand(original, { type: 'task.update', id: 'a', patch: { notes: 'Evidence reviewed' } }, LATER);
  assert.equal(edited.tasks[0].completedAt, NOW);
  const reopened = applyCommand(edited, { type: 'task.update', id: 'a', patch: { status: 'review' } }, LATER);
  assert.equal(reopened.tasks[0].completedAt, null);
});

test('reopening a completed predecessor cannot invalidate completed dependents; archive preserves completion', () => {
  const original = workspace();
  original.tasks = [task('a', { title: 'Operating review', status: 'done' }), task('b', { title: 'Profit evaluation', status: 'done', dependsOn: ['a'] })];
  for (const status of ['todo']) {
    assert.throws(() => applyCommand(original, { type: 'task.update', id: 'a', patch: { status } }, LATER), /Profit evaluation|dependent/i);
  }
  assert.equal(original.tasks[0].status, 'done');
  const archived = applyCommand(original, { type: 'task.update', id: 'a', patch: { status: 'archived' } }, LATER);
  assert.equal(archived.tasks[0].completedAt, NOW);
  assert.deepEqual(getBlockers(archived.tasks[1], archived), []);
});

test('archiving a task clears its weekly commitment and can be reversed', () => {
  const original = workspace();
  original.tasks = [task('a', { weekly: true })];
  const archived = applyCommand(original, { type: 'task.update', id: 'a', patch: { status: 'archived', weekly: true } }, NOW);
  assert.equal(archived.tasks[0].weekly, false);
  const restored = applyCommand(archived, { type: 'task.update', id: 'a', patch: { status: 'todo' } }, LATER);
  assert.equal(restored.tasks[0].status, 'todo');
  assert.equal(restored.tasks[0].weekly, false);
});

test('existing task and milestone cannot be reassigned to a different project', () => {
  const original = workspace();
  original.tasks = [task('a')];
  original.milestones = [milestoneFixture({ ...milestone(), id: 'm1', updatedAt: NOW })];
  assert.throws(() => applyCommand(original, { type: 'task.update', id: 'a', patch: { projectId: 'p2' } }, NOW), /project/i);
  assert.throws(() => applyCommand(original, { type: 'milestone.update', id: 'm1', patch: { projectId: 'p2' } }, NOW), /project/i);
});

test('an achieved milestone requires evidence on create and update', () => {
  assert.throws(() => applyCommand(workspace(), { type: 'milestone.create', milestone: milestone({ status: 'achieved' }) }, NOW), /evidence/i);
  const created = applyCommand(workspace(), { type: 'milestone.create', milestone: milestone() }, NOW);
  assert.throws(() => applyCommand(created, { type: 'milestone.update', id: created.milestones[0].id, patch: { status: 'achieved', evidence: '  ' } }, NOW), /evidence/i);
  const achieved = applyCommand(created, { type: 'milestone.update', id: created.milestones[0].id, patch: { status: 'achieved', evidence: 'Owner reviewed an end-to-end demonstration.' } }, LATER);
  assert.equal(achieved.milestones[0].status, 'achieved');
  assert.equal(achieved.milestones[0].updatedAt, LATER);
});

test('project descriptions and goals are editable while identity and equal priority stay fixed', () => {
  const original = workspace();
  const edited = applyCommand(original, { type: 'project.update', id: 'p1', patch: { goal: '  Reliable on chosen devices  ', description: 'Map-enabled Android product.' } }, NOW);
  assert.equal(edited.projects[0].goal, 'Reliable on chosen devices');
  assert.equal(original.projects[0].goal, '');
  assert.throws(() => applyCommand(original, { type: 'project.update', id: 'p1', patch: { priority: 'high' } }, NOW), /field/i);
});

test('capture conversion is atomic, preserves content and source, and creates one proposed task', () => {
  const captured = applyCommand(workspace(), { type: 'capture.create', capture: capture() }, NOW);
  const id = captured.captures[0].id;
  const converted = applyCommand(captured, { type: 'capture.convert', id, milestoneId: null, horizon: 'next' }, LATER);
  assert.equal(captured.tasks.length, 0);
  assert.equal(captured.captures[0].status, 'inbox');
  assert.equal(converted.tasks.length, 1);
  const [created] = converted.tasks;
  assert.equal(created.title, captured.captures[0].title);
  assert.equal(created.notes, captured.captures[0].body);
  assert.equal(created.sourceUrl, captured.captures[0].sourceUrl);
  assert.equal(created.projectId, captured.captures[0].projectId);
  assert.equal(created.status, 'proposed');
  assert.equal(created.priority, 'normal');
  assert.equal(created.horizon, 'next');
  assert.equal(created.weekly, false);
  assert.equal(created.dueDate, null);
  assert.equal(converted.captures[0].status, 'filed');
  assert.equal(converted.captures[0].convertedTaskId, created.id);
  assert.throws(() => applyCommand(converted, { type: 'capture.convert', id, milestoneId: null, horizon: 'now' }, LATER), /already|converted/i);
});

test('unassigned or archived captures cannot convert and validation failures preserve the inbox', () => {
  const unassigned = applyCommand(workspace(), { type: 'capture.create', capture: capture({ projectId: null }) }, NOW);
  const id = unassigned.captures[0].id;
  assert.throws(() => applyCommand(unassigned, { type: 'capture.convert', id, milestoneId: null, horizon: 'now' }, NOW), /project/i);
  const assigned = applyCommand(unassigned, { type: 'capture.update', id, patch: { projectId: 'p1' } }, NOW);
  assert.throws(() => applyCommand(assigned, { type: 'capture.convert', id, milestoneId: 'missing', horizon: 'now' }, NOW), /milestone/i);
  assert.equal(assigned.captures[0].status, 'inbox');
  const archived = applyCommand(assigned, { type: 'capture.update', id, patch: { status: 'archived', kind: 'decision' } }, NOW);
  assert.equal(archived.captures[0].kind, 'decision');
  assert.throws(() => applyCommand(archived, { type: 'capture.convert', id, milestoneId: null, horizon: 'now' }, NOW), /archived/i);
});

test('conversion can assign an unassigned capture and create its task in one command', () => {
  const captured = applyCommand(workspace(), { type: 'capture.create', capture: capture({ projectId: null }) }, NOW);
  const before = structuredClone(captured);
  const converted = applyCommand(captured, { type: 'capture.convert', id: captured.captures[0].id, projectId: 'p2', milestoneId: null, horizon: 'next' }, LATER);
  assert.deepEqual(captured, before);
  assert.equal(converted.captures[0].projectId, 'p2');
  assert.equal(converted.captures[0].status, 'filed');
  assert.equal(converted.tasks[0].projectId, 'p2');
  assert.equal(converted.captures[0].convertedTaskId, converted.tasks[0].id);
  assert.equal(converted.activity.length, captured.activity.length + 1);
  assert.equal(converted.activity.at(-1)!.projectId, 'p2');
});

test('the selected project overrides the capture project and validates its selected milestone', () => {
  const captured = applyCommand(workspace(), { type: 'capture.create', capture: capture({ projectId: 'p1' }) }, NOW);
  captured.milestones = [milestoneFixture({ ...milestone({ projectId: 'p2' }), id: 'm2', updatedAt: NOW })];
  const converted = applyCommand(captured, { type: 'capture.convert', id: captured.captures[0].id, projectId: 'p2', milestoneId: 'm2', horizon: 'now' }, LATER);
  assert.equal(captured.captures[0].projectId, 'p1');
  assert.equal(converted.captures[0].projectId, 'p2');
  assert.equal(converted.tasks[0].projectId, 'p2');
  assert.equal(converted.tasks[0].milestoneId, 'm2');
  assert.equal(converted.tasks[0].notes, captured.captures[0].body);
  assert.equal(converted.tasks[0].sourceUrl, captured.captures[0].sourceUrl);
});

test('an invalid selected project cannot change the capture or create a task', () => {
  const captured = applyCommand(workspace(), { type: 'capture.create', capture: capture({ projectId: 'p1' }) }, NOW);
  const before = structuredClone(captured);
  for (const [projectId, message] of [['foreign', /existing project/i], [null, /project must be text/i], [7, /project must be text/i]] as const) {
    assert.throws(() => applyCommand(captured, { type: 'capture.convert', id: captured.captures[0].id, projectId, milestoneId: null, horizon: 'now' }, LATER), message);
    assert.deepEqual(captured, before);
  }
});

test('a foreign milestone in a conversion rejects the project reassignment too', () => {
  const captured = applyCommand(workspace(), { type: 'capture.create', capture: capture({ projectId: 'p1' }) }, NOW);
  captured.milestones = [milestoneFixture({ ...milestone({ projectId: 'p1' }), id: 'm1', updatedAt: NOW })];
  const before = structuredClone(captured);
  assert.throws(() => applyCommand(captured, { type: 'capture.convert', id: captured.captures[0].id, projectId: 'p2', milestoneId: 'm1', horizon: 'now' }, LATER), /milestone belonging to this project/i);
  assert.deepEqual(captured, before);
});

test('conversion capacity failure leaves the original project and capture status intact', () => {
  const captured = applyCommand(workspace(), { type: 'capture.create', capture: capture({ projectId: 'p1' }) }, NOW);
  captured.tasks = Array.from({ length: 2000 }, (_, i) => task(`t${i}`));
  const before = structuredClone(captured);
  assert.throws(() => applyCommand(captured, { type: 'capture.convert', id: captured.captures[0].id, projectId: 'p2', milestoneId: null, horizon: 'now' }, LATER), /2000|limit/i);
  assert.deepEqual(captured, before);
});

test('workspace size and activity bounds prevent unbounded writes', () => {
  const full = workspace();
  full.tasks = Array.from({ length: 2000 }, (_, i) => task(`t${i}`));
  assert.throws(() => applyCommand(full, { type: 'task.create', task: input() }, NOW), /2000|limit/i);
  const captures = workspace();
  captures.captures = Array.from({ length: 1000 }, (_, i) => ({ ...capture(), id: `c${i}`, status: 'inbox', createdAt: NOW, convertedTaskId: null }));
  assert.throws(() => applyCommand(captures, { type: 'capture.create', capture: capture() }, NOW), /1000|limit/i);
  const milestones = workspace();
  milestones.milestones = Array.from({ length: 100 }, (_, i) => milestoneFixture({ ...milestone(), id: `m${i}`, updatedAt: NOW, sortKey:i }));
  assert.throws(() => applyCommand(milestones, { type: 'milestone.create', milestone: milestone() }, NOW), /100|limit/i);
  const logged = workspace();
  logged.activity = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, text: `Old ${i}`, at: NOW, projectId: null }));
  const next = applyCommand(logged, { type: 'task.create', task: input() }, LATER);
  assert.equal(next.activity.length, 100);
  assert.ok(next.activity.some((item) => item.at === LATER));
});

test('capture conversion respects the task capacity without partially filing the capture', () => {
  const captured = applyCommand(workspace(), { type: 'capture.create', capture: capture() }, NOW);
  captured.tasks = Array.from({ length: 2000 }, (_, i) => task(`t${i}`));
  assert.throws(() => applyCommand(captured, { type: 'capture.convert', id: captured.captures[0].id, milestoneId: null, horizon: 'now' }, NOW), /2000|limit/i);
  assert.equal(captured.captures[0].status, 'inbox');
});

test('recommendations exclude all blocked, archived and completed work', () => {
  const original = workspace();
  original.tasks = [task('done', { status: 'done' }), task('archived', { status: 'archived' }), task('blocked', { blocker: 'Waiting' }), task('dependent', { dependsOn: ['blocked'] }), task('ready')];
  assert.deepEqual(getRecommendations(original, '2026-10-17').map((item) => item.taskId), ['ready']);
});

test('recommendations interleave projects for equal exposure even when scores differ', () => {
  const original = workspace();
  original.tasks = [
    ...Array.from({ length: 5 }, (_, i) => task(`p1-${i}`, { projectId: 'p1', priority: 'high', weekly: true })),
    ...Array.from({ length: 5 }, (_, i) => task(`p2-${i}`, { projectId: 'p2', priority: 'low', horizon: 'later' })),
  ];
  const picks = getRecommendations(original, '2026-10-17');
  assert.equal(picks.length, 6);
  assert.deepEqual(picks.map((item) => item.taskId.slice(0, 2)), ['p1', 'p2', 'p1', 'p2', 'p1', 'p2']);
});

test('ranking reflects weekly commitments, priority, pending review, horizon and near dates', () => {
  const pairs: [Partial<TaskInput>, Partial<TaskInput>][] = [
    [{ weekly: true }, {}], [{ priority: 'high' }, { priority: 'low' }],
    [{ status: 'review' }, { status: 'todo' }], [{ horizon: 'now' }, { horizon: 'later' }],
    [{ dueDate: '2026-10-18' }, { dueDate: '2027-01-01' }],
  ];
  for (const [preferred, other] of pairs) {
    const original = workspace();
    original.tasks = [task('other', other), task('preferred', preferred)];
    assert.equal(getRecommendations(original, '2026-10-17')[0].taskId, 'preferred');
  }
});

test('recommendation reasons distinguish suggestions and never invent urgency', () => {
  const original = workspace();
  original.tasks = [task('idea', { status: 'proposed', horizon: 'later' }), task('today', { dueDate: '2026-10-17' }), task('tomorrow', { dueDate: '2026-10-18' })];
  const picks = getRecommendations(original, '2026-10-17');
  const reason = (id: string) => picks.find((item) => item.taskId === id)!.reason;
  assert.match(reason('idea'), /suggestion/i);
  assert.doesNotMatch(reason('idea'), /due|urgent|overdue|week/i);
  assert.match(reason('today'), /due today/i);
  assert.match(reason('tomorrow'), /1 day|tomorrow/i);
});

test('recommendation date arithmetic handles month and year boundaries in UTC', () => {
  const original = workspace();
  original.tasks = [task('new-year', { dueDate: '2027-01-01' })];
  assert.match(getRecommendations(original, '2026-12-31')[0].reason, /1 day|tomorrow/i);
  assert.throws(() => getRecommendations(original, '2026-02-31'), /date/i);
});

test('seed expresses editable suggestions, equal projects and dated historical evidence', () => {
  const seed = createSeedWorkspace(NOW);
  assert.deepEqual(seed.projects.map((item) => item.name), ['TAMENNI', 'Trade Graph']);
  assert.ok(seed.projects.every((item) => item.priority === 'equal'));
  assert.equal(seed.milestones.filter((item) => item.projectId === seed.projects[0].id).length, 5);
  assert.equal(seed.milestones.filter((item) => item.projectId === seed.projects[1].id).length, 2);
  assert.ok(seed.tasks.length >= 9 && seed.tasks.length <= 12);
  assert.ok(seed.tasks.every((item) => item.status === 'proposed' && item.dueDate === null && !item.weekly));
  assert.ok(seed.milestones.every((item) => item.targetDate === null && item.status === 'planned'));
  assert.ok(seed.milestones.some((item) => item.title === 'Profitability demonstrated' && /net.profit criterion.*met/i.test(item.acceptance) && /evidence period/i.test(item.acceptance)));
  assert.ok(seed.milestones.some((item) => item.title === 'Viable profit structure validated' && /viability criteria/i.test(item.acceptance)));
  assert.match(seed.projects[1].goal, /demonstrated profitability/i);
  const landmark = seed.tasks.find((item) => item.sourceUrl === 'https://github.com/krybaby7/tameni-map-lab/pull/103');
  assert.ok(landmark);
  assert.match(landmark.notes, /17 October 2026|2026-10-17/);
  assert.match(landmark.notes, /snapshot|observ|historical/i);
  assert.match(landmark.notes, /review/i);
  const profitability = seed.tasks.find((item) => /profitability/i.test(item.title));
  assert.ok(profitability && profitability.dependsOn.length > 0);
  assert.ok(getBlockers(profitability, seed).length > 0);
  assert.equal(seed.activity.length > 0, true);
  assert.notEqual(createSeedWorkspace(NOW), seed);
});
