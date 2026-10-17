import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { readMutation, RequestError } from '../../../lib/api-guards';
import { loadWorkspace, saveWorkspace } from '../../../lib/workspace-store';
import { createSeedWorkspace } from '../../../lib/seed';
import { applyCommand } from '../../../lib/planning';

export const dynamic = 'force-dynamic';
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' } });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to open your workspace.' }, 401);
  if (!env.DB) return json({ error: 'Workspace storage is temporarily unavailable. Please try again.' }, 503);
  try {
    const now = new Date().toISOString();
    return json(await loadWorkspace(env.DB, user.userId, () => createSeedWorkspace(now), now));
  } catch {
    console.error('Could not read the project workspace.');
    return json({ error: 'Your workspace could not be loaded. Please try again.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Your session has ended. Sign in again before saving.' }, 401);
  if (!env.DB) return json({ error: 'Workspace storage is temporarily unavailable. Your draft has not been saved.' }, 503);
  try {
    const { revision, command } = await readMutation(request);
    const now = new Date().toISOString();
    const current = await loadWorkspace(env.DB, user.userId, () => createSeedWorkspace(now), now);
    if (current.revision !== revision) return json({ error: 'Your plan changed on another tab or device. Review the refreshed plan and save your draft again.' }, 409);
    let workspace;
    try { workspace = applyCommand(current.workspace, command, now); }
    catch (error) { return json({ error: error instanceof Error ? error.message : 'This change is not valid.' }, 400); }
    if (new TextEncoder().encode(JSON.stringify(workspace)).byteLength > 1_000_000) return json({ error: 'Your workspace is full. Export a backup and shorten large saved excerpts before adding more.' }, 413);
    const saved = await saveWorkspace(env.DB, user.userId, revision, workspace, now);
    if (!saved) return json({ error: 'Your plan changed on another tab or device. Review the refreshed plan and save your draft again.' }, 409);
    return json(saved);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    console.error('Could not save the project workspace.');
    return json({ error: 'Your change could not be saved. Keep this draft open and try again.' }, 503);
  }
}
