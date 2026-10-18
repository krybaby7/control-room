import type { Page, Route } from '@playwright/test';
export interface CapturedServerResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  submitted: unknown;
}
/** Read the actual upstream response through Playwright's API transport before
 * fulfilling it unchanged. Browser navigation cannot evict this copied body.
 * No retries, fabricated responses, altered status, or duplicate POSTs. */
export async function capturePostResponse(page: Page, pathname: string, action: () => Promise<void>): Promise<CapturedServerResponse> {
  let resolve!: (value: CapturedServerResponse) => void;
  let reject!: (error: unknown) => void;
  const captured = new Promise<CapturedServerResponse>((yes, no) => { resolve = yes; reject = no; });
  const matches = (url: URL) => url.pathname === pathname;
  let claimed = false;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST' || claimed) { await route.continue(); return; }
    claimed = true;
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      try {
        const body = await response.body();
        const result = { status: response.status(), ok: response.ok(), headers: response.headers(), body: Buffer.from(body), submitted: /^application\/json(?:\s*;|$)/i.test(route.request().headers()['content-type'] ?? '') ? route.request().postDataJSON() as unknown : null };
        await route.fulfill({ status: result.status, headers: result.headers, body });
        resolve(result);
      } finally { await response.dispose(); }
    } catch (error) { reject(error); await route.abort('failed').catch(() => {}); }
  };
  await page.route(matches, handler);
  try { const [, response] = await Promise.all([action(), captured]); return response; }
  finally { await page.unroute(matches, handler); }
}
