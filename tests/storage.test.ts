import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadWorkspace, saveWorkspace } from '../lib/workspace-store.ts';
import type { SqlDatabase } from '../lib/workspace-store.ts';
import type { Workspace } from '../lib/types.ts';

const instant = '2026-10-17T12:00:00.000Z';
const seed = (): Workspace => ({ schemaVersion: 1, projects: [], milestones: [], tasks: [], captures: [], activity: [] });
function database(): SqlDatabase {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE workspaces (user_id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)');
  return { prepare(sql) { let values: (string | number | null)[] = []; return {
    bind(...args) { values = args; return this; },
    async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null; },
    async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
  }; } };
}

test('initializes one durable workspace and never replaces existing edits with seed', async () => {
  const db = database();
  const first = await loadWorkspace(db, 'owner', seed, instant);
  assert.equal(first?.revision, 1);
  const changed = seed(); changed.activity.push({ id: 'edit', text: 'My plan', at: instant, projectId: null });
  assert.equal((await saveWorkspace(db, 'owner', 1, changed, instant))?.revision, 2);
  const reopened = await loadWorkspace(db, 'owner', seed, instant);
  assert.equal(reopened?.workspace.activity[0]?.text, 'My plan');
  assert.equal(reopened?.revision, 2);
});

test('owner isolation prevents reading or writing another user workspace', async () => {
  const db = database();
  await loadWorkspace(db, 'owner-a', seed, instant);
  const a = seed(); a.activity.push({ id: 'private', text: 'Private note', at: instant, projectId: null });
  await saveWorkspace(db, 'owner-a', 1, a, instant);
  const b = await loadWorkspace(db, 'owner-b', seed, instant);
  assert.equal(b?.workspace.activity.length, 0);
  assert.equal(await saveWorkspace(db, 'uninitialized-user', 2, seed(), instant), null);
  assert.equal((await loadWorkspace(db, 'owner-a', seed, instant))?.workspace.activity[0].text, 'Private note');
});

test('a stale second device cannot overwrite the first device edit', async () => {
  const db = database();
  await loadWorkspace(db, 'owner', seed, instant);
  const phone = seed(); phone.activity.push({ id: 'phone', text: 'Phone edit', at: instant, projectId: null });
  const tablet = seed(); tablet.activity.push({ id: 'tablet', text: 'Stale edit', at: instant, projectId: null });
  const [savedPhone, savedTablet] = await Promise.all([
    saveWorkspace(db, 'owner', 1, phone, instant),
    saveWorkspace(db, 'owner', 1, tablet, instant),
  ]);
  assert.equal(savedPhone?.revision, 2);
  assert.equal(savedTablet, null);
  assert.equal((await loadWorkspace(db, 'owner', seed, instant))?.workspace.activity[0].text, 'Phone edit');
});
