export class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function readMutation(request: Request): Promise<{ revision: number; mutationId: string; command: unknown }> {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new RequestError('Please save changes from this app.', 403);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError('Use a JSON request.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError('The request is empty.', 400);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1_350_000) { await reader.cancel(); throw new RequestError('This entry is too large. A workspace backup must fit the planning storage limit.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RequestError('The request is not valid JSON.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('A change and revision are required.', 400);
  const input=body as Record<string,unknown>;
  const versioned='protocolVersion' in input;
  const allowed=versioned?['protocolVersion','expectedRevision','mutationId','command']:['revision','mutationId','command'];
  if(Object.keys(input).some(key=>!allowed.includes(key)) || versioned && input.protocolVersion!==1)throw new RequestError('Unsupported command envelope.',400);
  const revision=versioned?input.expectedRevision:input.revision;
  const { mutationId, command }=input;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || !command || typeof command !== 'object' || Array.isArray(command)) throw new RequestError('A valid change and revision are required.', 400);
  if (typeof mutationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(mutationId)) throw new RequestError('A valid mutation ID is required.', 400);
  if ((command as {type?: unknown}).type !== 'workspace.restore' && length > 65_536) throw new RequestError('This entry is too large. Shorten the excerpt and try again.', 413);
  return { revision, mutationId, command };
}
