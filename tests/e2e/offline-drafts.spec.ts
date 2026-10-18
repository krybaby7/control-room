import { test, expect } from '@playwright/test';
import { openFixture, setFixtureSession } from './helpers';

async function openDeviceSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Drafts on a trusted device' })).toBeVisible();
}
async function unlock(page: import('@playwright/test').Page) {
  await openDeviceSettings(page);
  await page.getByRole('button', { name: 'Enable or unlock trusted-device drafts', exact: true }).click();
  await expect(page.getByText('Trusted-device drafts are unlocked.', { exact: false })).toBeVisible();
}

test('trusted-device storage is opt-in, survives offline draft closure, and isolates owners', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    const counter = { opens: 0 };
    Object.defineProperty(window, 'deviceDraftTestCounter', { value: counter });
    IDBFactory.prototype.open = function (name, version) { counter.opens++; return original.call(this, name, version); };
  });
  // Keep the application/session reachable while its server draft storage is offline.
  await page.route('**/api/workspace/drafts', async route => {
    if (route.request().method() === 'POST') await route.abort('connectionfailed');
    else await route.fulfill({ json: { drafts: [] } });
  });
  await openFixture(page);
  await openDeviceSettings(page);
  expect(await page.evaluate(() => (window as unknown as { deviceDraftTestCounter: { opens: number } }).deviceDraftTestCounter.opens)).toBe(0);
  await unlock(page);
  expect(await page.evaluate(() => (window as unknown as { deviceDraftTestCounter: { opens: number } }).deviceDraftTestCounter.opens)).toBeGreaterThan(0);
  const title = `Synthetic device draft ${crypto.randomUUID()}`;
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Recover draft', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await unlock(page);
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await page.getByRole('button', { name: 'Recover draft', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
  await setFixtureSession(page, 'b'); await page.reload(); await unlock(page);
  await expect(page.getByText('0 device drafts retained.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
});

test('session expiry locks and forgets device drafts before another unlock', async ({ page }) => {
  await page.route('**/api/workspace/drafts', async route => {
    if (route.request().method() === 'POST') await route.abort('connectionfailed');
    else await route.fulfill({ json: { drafts: [] } });
  });
  await openFixture(page); await unlock(page);
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(`Synthetic expired device draft ${crypto.randomUUID()}`);
  await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
  await setFixtureSession(page, 'expired');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Your session has expired.' })).toBeVisible();
  await setFixtureSession(page, 'a'); await page.reload(); await unlock(page);
  await expect(page.getByText('0 device drafts retained.', { exact: false })).toBeVisible();
});

test('explicit forget clears a prior locked device copy without unlocking it into the editor', async ({ page }) => {
  await page.route('**/api/workspace/drafts', async route => {
    if (route.request().method() === 'POST') await route.abort('connectionfailed');
    else await route.fulfill({ json: { drafts: [] } });
  });
  await openFixture(page); await unlock(page);
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(`Synthetic locked copy ${crypto.randomUUID()}`);
  await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await openDeviceSettings(page);
  await page.getByRole('button', { name: 'Forget device drafts and lock storage', exact: true }).click();
  await expect(page.getByText('Device drafts were forgotten. Storage is locked.', { exact: true })).toBeVisible();
  await unlock(page);
  await expect(page.getByText('0 device drafts retained.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recover draft', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
});
