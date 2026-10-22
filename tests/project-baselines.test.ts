import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand } from '../lib/planning.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { parseWorkspaceExport } from '../lib/workspace-validation.ts';
import { baselineApplicationState, getProjectBaseline, previewProjectBaseline, applyProjectBaseline, PROJECT_BASELINES } from '../lib/project-baselines.ts';
import type { Workspace } from '../lib/types.ts';

const AT = '2026-10-17T16:20:30.000Z';
const LATER = '2026-10-19T12:00:00.000Z';
function apply(workspace: Workspace, projectId = workspace.projects[0].id) {
  return applyCommand(workspace, { type: 'baseline.apply', projectId, baselineId: '2026-10-17' }, AT);
}

test('baseline adds only five proposed tasks and one filed context, preserving all existing records', () => {
  const original = createSeedWorkspace(AT);
  original.projects[0].name = 'Owner renamed this project';
  original.projects[0].goal = 'My edited outcome';
  original.milestones[0].targetDate = '2027-02-03';
  original.tasks[0] = { ...original.tasks[0], status: 'done', completedAt: AT, dueDate: '2026-10-21', weekly: true, weeklyWeek: '2026-10-12' };
  original.tasks[2].blocker = 'Keep my blocker';
  const before = structuredClone(original);
  const next = apply(original);
  assert.deepEqual(original, before);
  assert.deepEqual(next.projects, before.projects);
  assert.deepEqual(next.milestones, before.milestones);
  assert.deepEqual(next.tasks.slice(0, before.tasks.length), before.tasks);
  assert.deepEqual(next.captures.slice(0, before.captures.length), before.captures);
  assert.equal(next.tasks.length, before.tasks.length + 5);
  assert.equal(next.captures.length, before.captures.length + 1);
  const added = next.tasks.slice(before.tasks.length);
  for (const task of added) {
    assert.equal(task.projectId, original.projects[0].id);
    assert.equal(task.status, 'proposed');
    assert.equal(task.dueDate, null);
    assert.equal(task.weekly, false);
    assert.equal(task.weeklyWeek, null);
    assert.equal(task.completedAt, null);
    assert.equal(task.priority, 'normal');
    assert.deepEqual(task.dependsOn, []);
    assert.match(task.notes, /Acceptance:/);
    assert.match(task.notes, /Source/);
  }
  const context = next.captures.at(-1)!;
  assert.equal(context.status, 'filed');
  assert.equal(context.kind, 'decision');
  assert.ok(context.body.length <= 10000);
  assert.match(context.body, /2026-10-17/);
  assert.match(context.body, /documented/i);
  assert.match(context.body, /d980806/);
  assert.doesNotMatch(context.body, /C:[\\/]|\/Users\//);
});

test('both projects apply independently, export/restore keeps evidence and deterministic replay preserves edits and archives', () => {
  const seed = createSeedWorkspace(AT);
  const first = apply(seed);
  const both = apply(first, first.projects[1].id);
  assert.equal(both.tasks.length, seed.tasks.length + 10);
  assert.equal(both.captures.length, seed.captures.length + 2);
  const added = both.tasks.slice(seed.tasks.length);
  assert.equal(added.filter(t => t.projectId === seed.projects[0].id).length, 5);
  assert.equal(added.filter(t => t.projectId === seed.projects[1].id).length, 5);
  const archived = added[0];
  archived.title = 'Owner revised proposal';
  archived.notes = 'Keep my rewritten acceptance';
  archived.status = 'archived';
  archived.archivedFromStatus = 'proposed';
  archived.updatedAt = LATER;
  const roundtrip = parseWorkspaceExport(JSON.parse(JSON.stringify({ workspace: both, updatedAt: LATER })));
  const repeated = apply(apply(roundtrip), roundtrip.projects[1].id);
  assert.deepEqual(repeated, roundtrip);
  assert.match(roundtrip.captures.at(-1)!.body, /9fa7efb/);
  assert.match(roundtrip.captures.at(-1)!.body, /profitability.*unproven|no demonstrated profitability/i);
  assert.ok(roundtrip.captures.at(-1)!.body.length <= 10000);
});

test('repository identity is authoritative, including canonical HTTPS git URLs, and names alone never apply', () => {
  const seed = createSeedWorkspace(AT);
  seed.projects[0].repositories = [{ name: 'Renamed repo', url: 'https://github.com/KRYBABY7/TMNI.git/' }];
  assert.equal(apply(seed).tasks.length, seed.tasks.length + 5);
  seed.projects[0].repositories = [{ name: 'Application', url: 'https://github.com/another-owner/TMNI' }];
  assert.throws(() => apply(seed), /verified repository|supported project/i);
  seed.projects[0].repositories = [{ name: 'Spoofed', url: 'https://github.com.evil.test/krybaby7/TMNI' }];
  assert.throws(() => apply(seed), /verified repository|supported project/i);
  seed.projects[0].repositories = [{ name: 'Mixed', url: 'https://github.com/krybaby7/TMNI' }, { name: 'Other', url: 'https://github.com/krybaby7/trade-graph' }];
  assert.throws(() => apply(seed), /ambiguous|multiple/i);
});

test('milestones match exact original titles in this project; renamed or absent matches remain unlinked', () => {
  const seed = createSeedWorkspace(AT);
  const android = seed.milestones[0];
  android.title = 'My renamed reliability milestone';
  seed.milestones.push({ ...android, id: 'other-project-title', projectId: seed.projects[1].id, sortKey:seed.milestones.filter(m=>m.projectId===seed.projects[1].id).length, title: 'Android reliability accepted' });
  const next = apply(seed);
  const added = next.tasks.slice(seed.tasks.length);
  assert.equal(added[0].milestoneId, null);
  assert.equal(added[1].milestoneId, seed.milestones.find(m => m.title === 'Map launch coverage accepted')!.id);
  assert.equal(added[2].milestoneId, seed.milestones.find(m => m.title === 'Map lab integrated into the app')!.id);
  assert.equal(added[3].milestoneId, seed.milestones.find(m => m.title === 'Scaling readiness demonstrated')!.id);
  assert.equal(added[4].milestoneId, null);
  assert.match(added[0].notes, /Unlinked.*milestone/i);
});

test('capacity rejection is atomic for task, capture and byte limits', () => {
  for (const limit of ['tasks', 'captures', 'bytes']) {
    const seed = createSeedWorkspace(AT);
    if (limit === 'tasks') {
      const task = seed.tasks[0];
      seed.tasks = Array.from({ length: 1996 }, (_, i) => ({ ...structuredClone(task), id: 'existing-' + i, dependsOn: [] }));
    } else if (limit === 'captures') {
      const capture = seed.captures[0];
      seed.captures = Array.from({ length: 1000 }, (_, i) => ({ ...capture, id: 'capture-' + i }));
    } else {
      const capture = seed.captures[0];
      seed.captures = Array.from({ length: 147 }, (_, i) => ({ ...capture, id: 'large-' + i, body: 'x'.repeat(9900) }));
      // 147 bounded captures leave less than one capture of v5 content headroom.
      // The existing document fits 1.5 MB; baseline evidence and task notes must not.
      assert.doesNotThrow(() => parseWorkspaceExport(seed));
    }
    const before = structuredClone(seed);
    assert.throws(() => apply(seed), /limit|storage|capacity|1 MB/i);
    assert.deepEqual(seed, before);
  }
});

test('baseline command rejects malformed payloads and deterministic ID collisions without changing state', () => {
  const seed = createSeedWorkspace(AT);
  for (const command of [
    { type: 'baseline.apply', projectId: seed.projects[0].id },
    { type: 'baseline.apply', projectId: seed.projects[0].id, baselineId: 'yesterday' },
    { type: 'baseline.apply', projectId: 'foreign', baselineId: '2026-10-17' },
    { type: 'baseline.apply', projectId: seed.projects[0].id, baselineId: '2026-10-17', tasks: [] },
  ]) assert.throws(() => applyCommand(seed, command, AT), /baseline|project|field/i);
  const result = apply(seed);
  for (const kind of ['task-id-as-capture', 'context-id-as-task']) {
    const collision = structuredClone(seed);
    if (kind === 'task-id-as-capture') collision.captures.push({ ...result.captures.at(-1)!, id: result.tasks.at(-1)!.id });
    if (kind === 'context-id-as-task') collision.tasks.push({ ...result.tasks.at(-1)!, id: result.captures.at(-1)!.id });
    const before = structuredClone(collision);
    assert.throws(() => apply(collision), /collision|another project|conflict/i);
    assert.deepEqual(collision, before);
  }
});

test('preexisting own task IDs preserve edits; a marker with missing proposals is incomplete and cannot reinsert tasks', () => {
  const seed = createSeedWorkspace(AT);
  const complete = apply(seed);
  const partial = structuredClone(seed);
  partial.tasks.push({ ...complete.tasks.at(-1)!, title: 'Keep edited proposal', notes: 'Owner context' });
  const repaired = apply(partial);
  assert.equal(repaired.tasks.length, seed.tasks.length + 5);
  assert.equal(repaired.tasks.find(t => t.id === complete.tasks.at(-1)!.id)!.title, 'Keep edited proposal');
  const missing = structuredClone(complete);
  missing.tasks.pop();
  assert.throws(() => apply(missing), /incomplete|missing/i);
  assert.equal(missing.tasks.length, complete.tasks.length - 1);
});

test('valid 128-character project IDs still produce valid deterministic IDs', () => {
  const seed = createSeedWorkspace(AT);
  const oldId = seed.projects[0].id;
  const longId = 'p'.repeat(128);
  seed.projects[0].id = longId;
  for (const m of seed.milestones) if (m.projectId === oldId) m.projectId = longId;
  for (const t of seed.tasks) if (t.projectId === oldId) t.projectId = longId;
  const next = apply(seed, longId);
  assert.doesNotThrow(() => parseWorkspaceExport(next));
  assert.deepEqual(apply(next, longId), next);
});

test('application state requires marker and every proposal, regardless of edited or archived status', () => {
  const seed = createSeedWorkspace(AT);
  assert.equal(baselineApplicationState(seed, seed.projects[0].id).status, 'available');
  const full = apply(seed);
  assert.equal(baselineApplicationState(full, seed.projects[0].id).status, 'applied');
  full.captures.at(-1)!.status = 'archived';
  full.captures.at(-1)!.title = 'Owner renamed context';
  assert.equal(baselineApplicationState(full, seed.projects[0].id).status, 'applied');
  const noMarker = structuredClone(full);
  noMarker.captures.pop();
  const pending = baselineApplicationState(noMarker, seed.projects[0].id);
  assert.equal(pending.status, 'available');
  assert.equal(pending.existingCount, 5);
  assert.equal(pending.missingCount, 0);
  assert.equal(apply(noMarker).tasks.length, noMarker.tasks.length);
  full.tasks.pop();
  assert.equal(baselineApplicationState(full, seed.projects[0].id).status, 'incomplete');
});

test('bundled source context stays dated and portable, and installation is preparation only', () => {
  const seed = createSeedWorkspace(AT);
  for (const project of seed.projects) {
    const data = getProjectBaseline(project)!;
    assert.equal(data.checkedAt, '2026-10-17T16:20:30Z');
    for (const source of data.sources) {
      assert.doesNotMatch(source.path, /C:[\\/]|\/Users\//);
      if (!source.revision) assert.equal(source.url, undefined);
      if (source.url?.includes('/blob/')) assert.ok(source.url.includes(source.revision!));
    }
    const saved = apply(seed, project.id).captures.at(-1)!;
    assert.ok(saved.body.length <= 10000);
    for (const source of data.sources) {
      assert.ok(saved.body.includes(source.summary));
      assert.ok(saved.body.includes(source.path));
    }
  }
  const trade = PROJECT_BASELINES.find(b => b.key === 'trade-graph')!;
  const installation = trade.actions.find(a => a.key === 'install')!;
  assert.equal(installation.title, 'Prepare L3 installation acceptance');
  assert.match(installation.acceptance, /preparation only/);
  assert.match(trade.status, /dated report says not installed; current runtime is unverified/);
});



test('moved deterministic baseline tasks remain consumed with current-project links and unchanged source lineage',()=>{
  const seed=createSeedWorkspace(AT),full=apply(seed),projectId=seed.projects[0].id;
  const moved=full.tasks.at(-1)!;moved.projectId=seed.projects[1].id;moved.milestoneId=null;moved.title='Owner moved and renamed work';
  const original=structuredClone(moved);
  const proposal=previewProjectBaseline(full,projectId).find(row=>row.id===moved.id)!;
  assert.equal(proposal.exists,true);assert.equal(proposal.removed,false);assert.equal(proposal.currentProjectId,seed.projects[1].id);
  assert.equal(baselineApplicationState(full,projectId).status,'applied');
  const replayed=apply(full);assert.deepEqual(replayed.tasks.find(row=>row.id===moved.id),original);assert.deepEqual(replayed,full);
  const partial=structuredClone(seed);partial.tasks.push(structuredClone(moved));
  const completed=apply(partial);assert.equal(completed.tasks.filter(row=>row.id===moved.id).length,1);assert.deepEqual(completed.tasks.find(row=>row.id===moved.id),original);
});
test('owner task and context deletion tombstones prevent resurrection even when the context marker is absent',()=>{
  const seed=createSeedWorkspace(AT),full=apply(seed),projectId=seed.projects[0].id;
  const task=full.tasks.at(-1)!,marker=full.captures.at(-1)!;full.tasks.pop();full.captures.pop();
  const removed=[task.id,marker.id],before=structuredClone(full);
  const state=baselineApplicationState(full,projectId,removed);
  assert.equal(state.status,'applied');assert.equal(state.missingCount,0);assert.match(state.message,/previously applied; task removed/i);assert.match(state.message,/tombstone/i);
  const proposal=previewProjectBaseline(full,projectId,removed).find(row=>row.id===task.id)!;assert.equal(proposal.removed,true);assert.equal(proposal.exists,false);
  const replayed=applyProjectBaseline(full,projectId,'2026-10-17',LATER,removed);assert.deepEqual(replayed,before);assert.deepEqual(full,before);
});
test('removed context and proposals are skipped while genuinely new missing proposals can still be added',()=>{
  const seed=createSeedWorkspace(AT),full=apply(seed),projectId=seed.projects[0].id;
  const removedTask=full.tasks.at(-1)!,removedContext=full.captures.at(-1)!;
  const partial=structuredClone(seed),removed=[removedTask.id,removedContext.id];
  const result=applyProjectBaseline(partial,projectId,'2026-10-17',LATER,removed);
  assert.equal(result.tasks.length,seed.tasks.length+4);assert.equal(result.captures.length,seed.captures.length);
  assert.equal(result.tasks.some(row=>row.id===removedTask.id),false);assert.equal(result.captures.some(row=>row.id===removedContext.id),false);
  assert.equal(baselineApplicationState(result,projectId,removed).status,'applied');
});
test('tombstone claims never suppress a live foreign-kind ID collision',()=>{
  const seed=createSeedWorkspace(AT),full=apply(seed),projectId=seed.projects[0].id,id=full.tasks.at(-1)!.id;
  seed.captures.push({...seed.captures[0],id});
  assert.throws(()=>applyProjectBaseline(seed,projectId,'2026-10-17',LATER,[id]),/collision/);
});

test('archived project rejects new baseline records while an already-applied baseline remains a lossless no-op',()=>{
  const source=createSeedWorkspace(AT);source.projects[0].archivedAt=AT;const before=structuredClone(source);
  assert.throws(()=>apply(source),/Restore this project/);assert.deepEqual(source,before);
  const full=apply(createSeedWorkspace(AT));full.projects[0].archivedAt=AT;
  assert.deepEqual(apply(full),full);
  // Existing task IDs alone do not authorize adding a context into an archived project.
  full.captures.pop();assert.throws(()=>apply(full),/Restore this project/);
});
test('new baseline proposals skip archived milestone assignments but keep original title/source lineage',()=>{
  const source=createSeedWorkspace(AT),projectId=source.projects[0].id;source.milestones[0].archivedAt=AT;
  const preview=previewProjectBaseline(source,projectId);assert.equal(preview[0].milestoneId,null);assert.match(preview[0].milestoneNote,/archived/);
  const next=apply(source),added=next.tasks.slice(source.tasks.length);assert.equal(added[0].milestoneId,null);assert.match(added[0].notes,/original milestone/);assert.match(added[0].notes,/Source evidence/);
  assert.equal(added[0].title,PROJECT_BASELINES[0].actions[0].title);
  const existing=apply(createSeedWorkspace(AT));existing.milestones[0].archivedAt=AT;const original=structuredClone(existing.tasks);
  assert.deepEqual(apply(existing).tasks,original);
});

test('legacy baseline capacity fixture retains its original 1 MB input boundary before normalization',()=>{
 const legacy=createSeedWorkspace(AT);legacy.schemaVersion=4;delete legacy.areas;
 for(const task of legacy.tasks){delete task.areaId;delete task.workType;}
 const capture=legacy.captures[0];legacy.captures=Array.from({length:97},(_,i)=>({...capture,id:'legacy-large-'+i,body:'x'.repeat(9900)}));
 const before=structuredClone(legacy),migrated=parseWorkspaceExport(legacy);assert.equal(migrated.schemaVersion,5);assert.deepEqual(legacy,before);
 // One more capture crosses the historical bound even though v5 has headroom.
 const overflow=structuredClone(legacy);overflow.captures.push({...capture,id:'legacy-overflow',body:'x'.repeat(9900)});
 assert.throws(()=>parseWorkspaceExport(overflow),/1 MB legacy user-content/);assert.deepEqual(legacy,before);
});
