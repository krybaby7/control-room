'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { DeviceOutbox, browserInvalidationBus, type OutboxItem } from '@/lib/device-outbox';
import type { Draft } from '@/lib/drafts';
import { boundedRequest } from '@/lib/save-controller';
import { SessionExpiredError } from '@/lib/workspace-client';

async function verifyDeviceScope(): Promise<string> {
  return boundedRequest('/api/workspace/session', { credentials: 'same-origin', cache: 'no-store' }, async response => {
    if (!response.ok) throw new Error('Session verification failed. Device drafts remain locked.');
    const body = await response.json() as { deviceScope?: unknown };
    if (typeof body.deviceScope !== 'string' || !/^[a-f0-9]{64}$/.test(body.deviceScope)) throw new Error('Session verification was incomplete. Device drafts remain locked.');
    return body.deviceScope;
  });
}

export interface DeviceDraftController { forget(): Promise<void> }
interface DeviceDraftContext {
  enabled: boolean; items: OutboxItem[]; working: boolean; status: string;
  enable(): Promise<void>; forget(): Promise<void>; put(draft: Draft): Promise<void>; removeIfUnchanged(draft: Draft): Promise<boolean>;
}
const unavailable = async () => { throw new Error('Unlock trusted-device drafts before using device storage.'); };
const Context = createContext<DeviceDraftContext>({ enabled: false, items: [], working: false, status: '', enable: unavailable, forget: async () => {}, put: unavailable, removeIfUnchanged: async () => false });
export const useDeviceDrafts = () => useContext(Context);

export function DeviceDraftProvider({ expired, controllerRef, children }: { expired: boolean; controllerRef?: MutableRefObject<DeviceDraftController | null>; children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('Device storage is locked. Drafts stay in editor memory unless saved to your private workspace.');
  const box = useRef<DeviceOutbox | null>(null);
  const pending = useRef<Promise<DeviceOutbox> | null>(null);
  const generation = useRef(0);
  const forgetting = useRef(false);
  const opening = useRef(false);
  const alive = useRef(false);
  const closeBus = useRef<(() => void) | null>(null);
  const chain = useRef(Promise.resolve());
  const forgettingTask = useRef<Promise<void> | null>(null);
  const invalidateGeneration = useCallback(() => { generation.current++; }, []);

  const performForget = useCallback(async () => {
    const epoch = ++generation.current;
    forgetting.current = true;
    const current = box.current; box.current = null; current?.lock();
    const openingBox = pending.current;
    if (alive.current) { setEnabled(false); setItems([]); setWorking(true); }
    try {
      await chain.current.catch(() => {});
      const opened = await openingBox?.catch(() => null);
      if (!current && !opened) {
        // Explicit forget/sign-out may need to clear a locked copy from a prior visit.
        // No browser storage is opened until the current session verifies its scope.
        const scope = await verifyDeviceScope();
        if (!alive.current || generation.current !== epoch) throw new Error('The session changed before device storage could be cleared.');
        const purge = DeviceOutbox.open(scope, { trustedDevice: true, bus: browserInvalidationBus() });
        pending.current = purge;
        const locked = await purge;
        locked.lock();
        await locked.forget();
        if (pending.current === purge) pending.current = null;
      } else {
        for (const candidate of new Set([current, opened])) if (candidate) await candidate.forget();
      }
      if (pending.current === openingBox) pending.current = null;
      closeBus.current?.(); closeBus.current = null;
      if (alive.current && generation.current === epoch) setStatus('Device drafts were forgotten. Storage is locked.');
    } catch (error) {
      if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
      if (alive.current && generation.current === epoch) setStatus(error instanceof SessionExpiredError ? 'Device drafts remain locked. Sign in to the same account and explicitly forget them to clear any stored copies.' : 'Device drafts are locked, but clearing device storage failed. Try Forget device drafts again before signing out.');
      throw error;
    } finally {
      forgetting.current = false;
      if (alive.current && generation.current === epoch) setWorking(false);
    }
  }, []);

  const forget = useCallback(() => {
    if (forgettingTask.current) return forgettingTask.current;
    const task = performForget();
    forgettingTask.current = task;
    void task.finally(() => { if (forgettingTask.current === task) forgettingTask.current = null; }).catch(() => {});
    return task;
  }, [performForget]);

  useEffect(() => {
    alive.current = true;
    const expire = () => { void forget().catch(() => {}); };
    window.addEventListener('control-room-session-expired', expire);
    if (controllerRef) controllerRef.current = { forget };
    return () => {
      alive.current = false; invalidateGeneration(); box.current?.lock(); box.current = null; closeBus.current?.(); closeBus.current = null;
      window.removeEventListener('control-room-session-expired', expire);
      if (controllerRef) controllerRef.current = null;
    };
  }, [controllerRef, forget, invalidateGeneration]);
  useEffect(() => {
    if (!expired) return;
    generation.current++; box.current?.lock();
    queueMicrotask(() => { void forget().catch(() => {}); });
  }, [expired, forget]);

  const enable = async () => {
    if (expired || forgetting.current || opening.current || box.current) return;
    const epoch = ++generation.current;
    opening.current = true; setWorking(true); setStatus('Verifying your session before unlocking device drafts…');
    try {
      const deviceScope = await verifyDeviceScope();
      if (!alive.current || generation.current !== epoch || forgetting.current) return;
      const underlying = browserInvalidationBus();
      const bus = {
        publish: (namespace: string) => underlying.publish(namespace),
        subscribe(listener: (namespace: string) => void) {
          const unsubscribe = underlying.subscribe(namespace => {
            listener(namespace);
            if (namespace === `owner:${deviceScope}` && alive.current && generation.current === epoch) {
              generation.current++; box.current = null; setEnabled(false); setItems([]); setWorking(false); setStatus('Device drafts were locked by another tab. Verify your session to unlock again.');
            }
          });
          closeBus.current = unsubscribe;
          return unsubscribe;
        },
      };
      const openingBox = DeviceOutbox.open(deviceScope, { trustedDevice: true, bus });
      pending.current = openingBox;
      const opened = await openingBox;
      if (!alive.current || generation.current !== epoch || forgetting.current) { opened.lock(); return; }
      box.current = opened; setItems(opened.inspect()); setEnabled(true); setStatus('Trusted-device drafts are unlocked. Nothing is submitted automatically.');
    } catch (error) {
      if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
      if (alive.current && generation.current === epoch) { closeBus.current?.(); closeBus.current = null; setStatus('Trusted-device storage could not be unlocked. Keep the editor open or save drafts to your private workspace.'); }
    } finally {
      opening.current = false;
      if (alive.current && generation.current === epoch) setWorking(false);
    }
  };
  const put = async (draft: Draft) => {
    const current = box.current; const epoch = generation.current;
    if (expired || !current || forgetting.current) throw new Error('Device drafts are locked.');
    let error: unknown;
    chain.current = chain.current.then(async () => {
      if (generation.current !== epoch || box.current !== current) throw new Error('Device draft session changed.');
      try { await current.put(draft); }
      finally { if (alive.current && generation.current === epoch) setItems(current.inspect()); }
    }).catch(cause => { error = cause; });
    await chain.current;
    if (error) { if (alive.current && generation.current === epoch) setStatus('Device storage could not save this draft. Its in-memory copy is retained; keep the editor open.'); throw error; }
  };
  const removeIfUnchanged = async (draft: Draft): Promise<boolean> => {
    const current = box.current; const epoch = generation.current;
    if (expired || !current || forgetting.current) return false;
    let removed = false;
    let error: unknown;
    chain.current = chain.current.then(async () => {
      if (generation.current !== epoch || box.current !== current) return;
      const discarded = await current.discardIfUnchanged(draft.id, draft);
      if (alive.current && generation.current === epoch) { setItems(current.inspect()); removed = discarded; }
    }).catch(cause => { error = cause; });
    await chain.current;
    if (error) throw error;
    return removed;
  };
  return <Context.Provider value={{ enabled: enabled && !expired, items: expired ? [] : items, working, status, enable, forget, put, removeIfUnchanged }}>{children}</Context.Provider>;
}

export function DeviceDraftSettings() {
  const device = useDeviceDrafts();
  return <section className="panel data-panel" aria-labelledby="device-drafts-heading"><h2 id="device-drafts-heading">Drafts on a trusted device</h2><p>Device storage is off by default. Enable it only on a private device you trust: draft text and original save details will be kept in this browser. Reopening requires a fresh session check and explicit unlock. Nothing is queued or submitted automatically.</p><p role="status">{device.status}</p>{device.enabled && <p>{device.items.length} device drafts retained. Device copies are separate from drafts saved to your private workspace.</p>}<div className="data-actions"><button type="button" className="button secondary" disabled={device.working || device.enabled} onClick={() => void device.enable()}>Enable or unlock trusted-device drafts</button><button type="button" className="button secondary" disabled={device.working} onClick={() => void device.forget().catch(() => {})}>Forget device drafts and lock storage</button></div></section>;
}
