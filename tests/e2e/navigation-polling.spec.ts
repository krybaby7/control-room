import { test, expect, type Page } from '@playwright/test';
import { fixtureOrigin, openFixture, workspace, clickFixtureNavigation } from './helpers';
import { entityHref } from '../../lib/entity-links';
import type { WorkspaceEnvelope } from '../../lib/types';

async function ownerCommand(page: Page, command: unknown): Promise<WorkspaceEnvelope> {
  const before = await workspace(page);
  const ticket = await page.request.post('/api/workspace/mutation-ids', { headers: { Origin: fixtureOrigin }, data: {} });
  expect(ticket.ok()).toBeTruthy();
  const { mutationId } = await ticket.json();
  const response = await page.request.post('/api/workspace', { headers: { Origin: fixtureOrigin }, data: { revision: before.revision, mutationId, command } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function addRecord(page: Page, kind: 'task' | 'capture', title: string, text: string) {
  const before = await workspace(page);
  const saved = kind === 'task'
    ? await ownerCommand(page, { type: 'task.create', task: { projectId: before.workspace.projects.find((row: { archivedAt: string | null }) => !row.archivedAt).id, milestoneId: null, title, notes: text, status: 'todo', horizon: 'now', priority: 'normal', dueDate: null, weekly: false, dependsOn: [], blocker: '', sourceUrl: null, evidence: '', estimateMinutes: null } })
    : await ownerCommand(page, { type: 'capture.create', capture: { title, body: text, projectId: null, kind: 'idea', sourceUrl: null } });
  const record = kind === 'task' ? saved.workspace.tasks.find(row => row.title === title) : saved.workspace.captures.find(row => row.title === title);
  expect(record).toBeTruthy();
  return record!;
}

for (const kind of ['task', 'capture'] as const) test(`back navigation keeps a cancelled dirty ${kind} and remounts the accepted destination`, async ({ page }) => {
  await openFixture(page);
  const suffix = crypto.randomUUID();
  const first = await addRecord(page, kind, `Synthetic navigation A ${suffix}`, `Original A ${suffix}`);
  const second = await addRecord(page, kind, `Synthetic navigation B ${suffix}`, `Original B ${suffix}`);
  const firstUrl = entityHref({ kind, id: first.id });
  const secondUrl = entityHref({ kind, id: second.id });
  await page.goto(firstUrl);
  const title = page.getByLabel(kind === 'task' ? 'Task title' : 'Title', { exact: true });
  const details = page.getByLabel(kind === 'task' ? 'Notes' : 'Details', { exact: true });
  await expect(title).toHaveValue(first.title);
  const editedTitle = `Unsaved A ${suffix}`;
  await title.fill(editedTitle);
  await expect(page.getByText('Draft saved separately', { exact: true })).toBeVisible();
  // Two same-document entries let real browser Back dispatch popstate into the open editor.
  await page.evaluate(({ previous, current }) => { history.replaceState({}, '', previous); history.pushState({}, '', current); }, { previous: secondUrl, current: firstUrl });
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); });
  await page.goBack();
  await expect(title).toHaveValue(editedTitle);
  expect(new URL(page.url()).searchParams.get('id')).toBe(first.id);
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.accept(); });
  await page.goBack();
  await expect(title).toHaveValue(second.title);
  await expect(details).toHaveValue(`Original B ${suffix}`);
  expect(new URL(page.url()).searchParams.get('id')).toBe(second.id);
  const saved = await workspace(page);
  const rows = kind === 'task' ? saved.workspace.tasks : saved.workspace.captures;
  expect(rows.find((row: { id: string }) => row.id === first.id).title).toBe(first.title);
  expect(rows.find((row: { id: string }) => row.id === second.id).title).toBe(second.title);
});

test('focus refresh preserves the dirty editor base and requires conflict review before an unchanged patch retry', async ({ page }) => {
  await openFixture(page);
  const suffix = crypto.randomUUID();
  const record = await addRecord(page, 'task', `Synthetic stale editor ${suffix}`, 'Original notes');
  await page.goto(entityHref({ kind: 'task', id: record.id }));
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(record.title);
  const openingRevision = (await workspace(page)).revision;
  const editedNotes = `Owner edit ${suffix}`;
  await page.getByLabel('Notes', { exact: true }).fill(editedNotes);
  await expect(page.getByText('Draft saved separately', { exact: true })).toBeVisible();
  const remoteTitle = `Concurrent title ${suffix}`;
  const remote = await ownerCommand(page, { type: 'task.update', id: record.id, patch: { title: remoteTitle } });
  expect(remote.revision).toBe(openingRevision + 1);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace' && response.request().method() === 'GET' && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(record.title);
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue(editedNotes);
  const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/api/workspace' && request.method() === 'POST');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  const original = (await sent).postDataJSON();
  expect(original.revision).toBe(openingRevision);
  expect(original.command.patch).toEqual({ notes: editedNotes });
  await expect(page.getByText('This workspace changed in another session.', { exact: false })).toBeVisible();
  let saved = await workspace(page);
  expect(saved.workspace.tasks.find((row: { id: string }) => row.id === record.id).title).toBe(remoteTitle);
  expect(saved.workspace.tasks.find((row: { id: string }) => row.id === record.id).notes).toBe('Original notes');
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue(editedNotes);
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  saved = await workspace(page);
  expect(saved.workspace.tasks.find((row: { id: string }) => row.id === record.id).title).toBe(remoteTitle);
  expect(saved.workspace.tasks.find((row: { id: string }) => row.id === record.id).notes).toBe(editedNotes);
});

for (const checkFirst of [false, true]) test(`an uncorrelated proxy 408 retains the original create identity through ${checkFirst ? 'Check original save then unchanged Save' : 'unchanged Save'}`, async ({ page }) => {
  await openFixture(page);
  const before = await workspace(page);
  const title = `Synthetic proxy timeout ${crypto.randomUUID()}`;
  let commandPosts = 0;
  let issuedIds = 0;
  let outcomeReads = 0;
  let allowOutcome = false;
  let originalMutationId: string | undefined;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/workspace/mutation-ids' && request.method() === 'POST') issuedIds++;
  });
  await page.route('**/api/workspace/mutations/**', async route => {
    outcomeReads++;
    if (allowOutcome) await route.continue();
    else await route.fulfill({ status: 503, json: { error: 'Synthetic outcome lookup unavailable' } });
  });
  await page.route('**/api/workspace', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    commandPosts++;
    originalMutationId ??= route.request().postDataJSON().mutationId;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await response.dispose();
    // A proxy status without the application's correlation and rejection diagnostic
    // is not proof that the upstream transaction did not commit.
    await route.fulfill({ status: 408, contentType: 'text/plain', body: 'Synthetic proxy timeout after upstream commit' });
  });
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByRole('button', { name: 'Capture it', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The save is still unconfirmed.');
  expect(commandPosts).toBe(1);
  expect(issuedIds).toBe(1);
  expect(outcomeReads).toBe(3);
  expect(originalMutationId).toBeTruthy();
  allowOutcome = true;
  if (checkFirst) {
    await dialog.getByRole('button', { name: 'Check original save', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Original change confirmed. Save the unchanged editor to acknowledge it, or close it before starting another change.');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(title);
    await expect(dialog.getByRole('button', { name: 'Check original save', exact: true })).toHaveCount(0);
    expect(commandPosts).toBe(1);
    expect(issuedIds).toBe(1);
  }
  await dialog.getByRole('button', { name: 'Capture it', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const after = await workspace(page);
  expect(commandPosts).toBe(1);
  expect(issuedIds).toBe(1);
  expect(outcomeReads).toBe(checkFirst ? 5 : 4);
  expect(after.revision).toBe(before.revision + 1);
  expect(after.workspace.captures.filter((row: { title: string }) => row.title === title)).toHaveLength(1);
  const receipt = await page.request.get(`/api/workspace/mutations/${originalMutationId}`);
  expect(receipt.ok()).toBeTruthy();
  expect((await receipt.json()).status).toBe('committed');
});


test('secondary navigation remains usable immediately after restoring a secondary URL', async ({ page }) => {
  await openFixture(page);
  const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  for (const name of ['Agents', 'Sources'] as const) {
    await clickFixtureNavigation(page, name);
    await page.reload();
    // Exercise the same immediate reload-to-navigation path as enrollment and
    // encrypted-draft recovery, without waiting for a feature panel first.
    await clickFixtureNavigation(page, name);
    await expect(navigation.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(navigation.locator('details')).toHaveAttribute('open', '');
    if (name === 'Agents') await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    else await expect(page.getByRole('region', { name: 'Review an import', exact: true })).toBeVisible();
  }
});
