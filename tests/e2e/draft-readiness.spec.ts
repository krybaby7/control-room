import { test, expect, type Page } from '@playwright/test';
import { fixtureOrigin, openFixture, workspace } from './helpers';

async function holdFirstDraftRead(page: Page) {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/workspace/drafts', async route => {
    if (route.request().method() !== 'GET' || held) { await route.continue(); return; }
    held = true;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    entered();
    await gate;
    await route.fulfill({ response });
    await response.dispose();
  });
  return { waiting, release };
}

test('Save waits for the real recovery read and Back cannot replace its editor while waiting', async ({ page }) => {
  await openFixture(page);
  const before = await workspace(page);
  const held = await holdFirstDraftRead(page);
  const title = `Synthetic early save ${crypto.randomUUID()}`;
  let commandPosts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/workspace' && request.method() === 'POST') commandPosts++; });
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await held.waiting;
  await page.evaluate(() => { history.replaceState({}, '', '/?view=projects'); history.pushState({}, '', '/'); });
  await dialog.getByRole('button', { name: 'Capture it', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  expect(commandPosts).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(fixtureOrigin + '/');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(title);
  expect(commandPosts).toBe(0);
  held.release();
  await expect(dialog).not.toBeVisible();
  const after = await workspace(page);
  expect(commandPosts).toBe(1);
  expect(after.revision).toBe(before.revision + 1);
  expect(after.workspace.captures.filter((row: { title: string }) => row.title === title)).toHaveLength(1);
});

test('an arriving saved version blocks an early Save until the owner explicitly reviews recovery', async ({ page }) => {
  await openFixture(page);
  const before = await workspace(page);
  const id = crypto.randomUUID();
  const originalTitle = `Synthetic pending recovery ${id}`;
  const now = new Date().toISOString();
  const seeded = await page.request.post('/api/workspace/drafts', {
    headers: { Origin: fixtureOrigin },
    data: { expectedRevision: 0, draft: { id, baseRevision: before.revision, entityType: 'capture', baseSnapshot: { title: '', body: '', projectId: null, kind: 'idea', sourceUrl: null, status: 'inbox' }, changedFields: { title: originalTitle }, createdAt: now, updatedAt: now, expiresAt: new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString() } },
  });
  expect(seeded.ok()).toBeTruthy();
  const held = await holdFirstDraftRead(page);
  let commandPosts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/workspace' && request.method() === 'POST') commandPosts++; });
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const newTitle = `Synthetic unreviewed intent ${crypto.randomUUID()}`;
  await dialog.getByLabel('Title', { exact: true }).fill(newTitle);
  await held.waiting;
  await dialog.getByRole('button', { name: 'Capture it', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  expect(commandPosts).toBe(0);
  held.release();
  await expect(dialog.getByRole('button', { name: 'Recover draft', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Capture it', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('alert')).toContainText('Review the saved draft recovery options before saving.');
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(newTitle);
  expect(commandPosts).toBe(0);
  expect((await workspace(page)).revision).toBe(before.revision);
  const stored = await page.request.get('/api/workspace/drafts');
  expect(stored.ok()).toBeTruthy();
  expect((await stored.json()).drafts.find((draft: { id: string }) => draft.id === id).changedFields.title).toBe(originalTitle);
  await dialog.getByRole('button', { name: 'Recover draft', exact: true }).click();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(originalTitle);
  await dialog.getByRole('button', { name: 'Discard draft changes', exact: true }).click();
  await expect(dialog.getByText('Draft discarded', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
