import { test, expect } from '@playwright/test';
import { setFixtureSession } from './helpers';

test('the page starts one workspace read before its code runs and renders from it', async ({ page }) => {
  await setFixtureSession(page, 'a');
  // Hold every code chunk until the workspace read is seen: only the page's HTML can start it.
  let reads = 0, beforeCode = false, released = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
  const fallback = setTimeout(() => release(), 10_000);
  page.on('request', request => {
    if (request.method() !== 'GET' || new URL(request.url()).pathname !== '/api/workspace') return;
    reads++;
    if (!released) { beforeCode = true; clearTimeout(fallback); release(); }
  });
  await page.route('**/_next/static/chunks/*.js', async route => { await gate; await route.continue(); });
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Last saved / })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeVisible();
  expect(beforeCode).toBe(true);
  expect(reads).toBe(1);
  expect(await page.evaluate(() => '__controlRoomBootRead' in window)).toBe(false);
});

test('a linked project opens without first painting the project lanes', async ({ page }) => {
  await setFixtureSession(page, 'a');
  const target = (await (await page.request.get('/api/workspace')).json()).workspace.projects.find((row: { archivedAt: string | null }) => !row.archivedAt);
  // Every frame before paint records whether the lanes home is on screen.
  await page.addInitScript(() => {
    const seen = { lanes: 0, frames: 0 };
    (window as unknown as { lanesFrames: typeof seen }).lanesFrames = seen;
    const frame = () => { seen.frames++; if (document.querySelector('.project-lanes')) seen.lanes++; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  await page.goto(`/?view=projects&entity=project&id=${target.id}`);
  await expect(page.getByRole('button', { name: 'Edit project', exact: true })).toBeVisible();
  const seen = await page.evaluate(() => (window as unknown as { lanesFrames: { lanes: number; frames: number } }).lanesFrames);
  expect(seen.frames).toBeGreaterThan(0);
  expect(seen.lanes).toBe(0);
});

test('a lost early read leaves the ordinary read to load the workspace', async ({ page }) => {
  await setFixtureSession(page, 'a');
  let reads = 0;
  await page.route('**/api/workspace', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    reads++;
    if (reads === 1) await route.abort('failed'); else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your workspace is waiting.', exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Last saved / })).toBeVisible();
  expect(reads).toBe(2);
});
