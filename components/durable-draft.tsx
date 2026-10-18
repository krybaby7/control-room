'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import { DRAFT_TTL_MS, type Draft, type SavedDraft } from '@/lib/drafts';
import { boundedRequest } from '@/lib/save-controller';
import { SessionExpiredError } from '@/lib/workspace-client';
import { SessionExpiredContext } from './session-state';
import { useDeviceDrafts } from './device-drafts';

export interface RecoveredSubmission { baseRevision: number; command?: Record<string, unknown>; mutationId?: string }
export interface DurableDraftController { preserveSubmission(command: unknown, mutationId: string): Promise<void>; releaseSubmission(): Promise<void> }
interface DraftContextValue { baseRevision: number; expired: boolean; controllerRef?: MutableRefObject<DurableDraftController | null>; onRecover?: (submission: RecoveredSubmission) => void }
const DraftContext = createContext<DraftContextValue>({ baseRevision: 0, expired: false });
export function DurableDraftProvider({ baseRevision, children, controllerRef, onRecover }: Omit<DraftContextValue, 'expired'> & { children: ReactNode }) {
  const [expired, setExpired] = useState(false);
  const sessionExpired = useContext(SessionExpiredContext);
  useEffect(() => {
    const expire = () => setExpired(true);
    window.addEventListener('control-room-session-expired', expire);
    return () => window.removeEventListener('control-room-session-expired', expire);
  }, []);
  return <DraftContext.Provider value={{ baseRevision, expired: expired || sessionExpired, controllerRef, onRecover }}>{expired || sessionExpired ? <p role="alert">Your session expired. Sign in again to continue.</p> : children}</DraftContext.Provider>;
}
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  try {
    return await boundedRequest(url, { credentials: 'same-origin', cache: 'no-store', ...init }, async response => {
      if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'unavailable');
      return await response.json() as T;
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
    throw error;
  }
}

export function useDurableDraft<T extends object>(entityType: string, entityId: string | undefined, initial: T) {
  const { baseRevision, controllerRef, onRecover } = useContext(DraftContext);
  const device = useDeviceDrafts();
  const deviceRef = useRef(device);
  useEffect(() => { deviceRef.current = device; }, [device]);
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [recovery, setRecovery] = useState<SavedDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [localRecovery, setLocalRecovery] = useState<Draft[]>([]);
  const [deviceChecked, setDeviceChecked] = useState(false);
  const [localStatus, setLocalStatus] = useState('');
  const localRecord = useRef<Draft | null>(null);
  const localTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const localRecoveryRef = useRef<Draft[]>([]);
  const deviceCheckedRef = useRef(false);
  const localChain = useRef(Promise.resolve());
  const [status, setStatus] = useState('');
  const [hasRecord, setHasRecord] = useState(false);
  const record = useRef<SavedDraft | null>(null);
  const attemptedMutation = useRef<string | null>(null);
  const generation = useRef(0);
  const chain = useRef(Promise.resolve());
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const identity = useRef({ id: crypto.randomUUID(), baseRevision, createdAt: new Date().toISOString() });
  const current = useRef(draft);
  const base = useRef(baseline);
  const recoveryRef = useRef(recovery);
  const readyRef = useRef(ready);
  useEffect(() => { current.current = draft; base.current = baseline; recoveryRef.current = recovery; readyRef.current = ready; localRecoveryRef.current = localRecovery; deviceCheckedRef.current = deviceChecked; }, [draft, baseline, recovery, ready, localRecovery, deviceChecked]);
  const failure = (error: unknown) => setStatus(error instanceof Error && error.message === 'conflict' ? 'This draft changed elsewhere. Close and reopen to review it.' : 'Draft could not be saved. Keep this editor open and try again.');

  useEffect(() => {
    const epoch = ++generation.current;
    void request<{ drafts: SavedDraft[] }>('/api/workspace/drafts').then(result => {
      if (generation.current !== epoch) return;
      const match = result.drafts.find(item => item.entityType === entityType && item.entityId === entityId);
      if (match) { record.current = match; setHasRecord(true); setRecovery(match); }
      setReady(true);
    }).catch(() => { if (generation.current === epoch) setStatus('Draft recovery could not be checked. Close and reopen this editor before saving.'); });
    return () => { generation.current = epoch + 1; clearTimeout(pendingTimer.current); clearTimeout(localTimer.current); };
  }, [entityType, entityId]);

  useEffect(() => {
    let cancelled = false;
    if (!device.enabled) {
      if (deviceChecked) queueMicrotask(() => { if (!cancelled) { setDeviceChecked(false); setLocalRecovery([]); setLocalStatus('Device drafts are locked.'); } });
    } else if (!deviceChecked) {
      const candidates = device.items.filter(item => item.draft.entityType === entityType && item.draft.entityId === entityId).map(item => item.draft);
      queueMicrotask(() => { if (!cancelled) { setLocalRecovery(candidates); setDeviceChecked(true); } });
    }
    return () => { cancelled = true; };
  }, [device.enabled, device.items, deviceChecked, entityType, entityId]);

  useEffect(() => {
    if (!device.enabled || !deviceChecked || recovery || localRecovery.length || JSON.stringify(draft) === JSON.stringify(baseline)) return;
    const epoch = generation.current;
    localTimer.current = setTimeout(() => {
      localChain.current = localChain.current.then(async () => {
        if (generation.current !== epoch || !deviceRef.current.enabled) return;
        const previous = localRecord.current ?? record.current;
        const now = new Date().toISOString();
        const payload: Draft = { ...identity.current, ...(previous ? { id: previous.id, baseRevision: previous.baseRevision, createdAt: previous.createdAt } : {}), entityType, ...(entityId ? { entityId } : {}), baseSnapshot: baseline as Record<string, unknown>, changedFields: Object.fromEntries(Object.entries(draft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify((baseline as Record<string, unknown>)[key]))), ...(previous?.command ? { command: previous.command } : {}), ...(previous?.mutationId ? { mutationId: previous.mutationId } : {}), updatedAt: now, expiresAt: new Date(Date.parse(now) + DRAFT_TTL_MS).toISOString() };
        localRecord.current = payload;
        await deviceRef.current.put(payload);
        if (generation.current === epoch) { localRecord.current = payload; setLocalStatus('Draft saved on this device'); }
      }).catch(() => { if (generation.current === epoch) setLocalStatus('Device copy could not be saved. Keep this editor open.'); });
    }, 1000);
    return () => clearTimeout(localTimer.current);
  }, [draft, baseline, device.enabled, deviceChecked, recovery, localRecovery, entityType, entityId]);

  useEffect(() => {
    clearTimeout(pendingTimer.current);
    if (!ready || recovery || localRecovery.length || (device.enabled && !deviceChecked) || JSON.stringify(draft) === JSON.stringify(baseline)) return;
    const epoch = generation.current;
    pendingTimer.current = setTimeout(() => {
      setStatus('Saving draft…');
      chain.current = chain.current.then(async () => {
        if (generation.current !== epoch) return;
        const previous = record.current;
        const now = new Date().toISOString();
        const changedFields = Object.fromEntries(Object.entries(draft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify((baseline as Record<string, unknown>)[key])));
        const payload = { ...identity.current, ...(previous ? { id: previous.id, baseRevision: previous.baseRevision, createdAt: previous.createdAt } : {}), entityType, ...(entityId ? { entityId } : {}), baseSnapshot: baseline, changedFields, ...(previous?.command ? { command: previous.command } : {}), ...(previous?.mutationId ? { mutationId: previous.mutationId } : {}), updatedAt: now, expiresAt: new Date(Date.parse(now) + DRAFT_TTL_MS).toISOString() };
        const result = await request<{ status: 'saved'; draft: SavedDraft }>('/api/workspace/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: previous?.draftRevision ?? 0, draft: payload }) });
        if (generation.current !== epoch) return;
        record.current = result.draft;
        setHasRecord(true);
        if (JSON.stringify(current.current) === JSON.stringify(draft)) setStatus('Draft saved separately');
      }).catch(error => { if (generation.current === epoch) failure(error); });
    }, 1000);
    return () => clearTimeout(pendingTimer.current);
  }, [draft, baseline, ready, recovery, localRecovery, device.enabled, deviceChecked, entityType, entityId]);

  useEffect(() => {
    if (!controllerRef) return;
    const controller: DurableDraftController = {
      async preserveSubmission(command, mutationId) {
        if (!readyRef.current || recoveryRef.current || localRecoveryRef.current.length || (deviceRef.current.enabled && !deviceCheckedRef.current)) throw new Error('Review the saved draft recovery options before saving.');
        const epoch = generation.current;
        clearTimeout(pendingTimer.current); clearTimeout(localTimer.current);
        const snapshot = current.current;
        let failure: unknown;
        chain.current = chain.current.then(async () => {
          if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
          const previous = record.current;
          if (previous?.mutationId && (previous.mutationId !== mutationId || JSON.stringify(previous.command) !== JSON.stringify(command))) throw new Error('Check the earlier save before submitting another change.');
          attemptedMutation.current = mutationId;
          const now = new Date().toISOString();
          const changedFields = Object.fromEntries(Object.entries(snapshot).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify((base.current as Record<string, unknown>)[key])));
          const payload = { ...identity.current, ...(previous ? { id: previous.id, baseRevision: previous.baseRevision, createdAt: previous.createdAt } : {}), entityType, ...(entityId ? { entityId } : {}), baseSnapshot: base.current, changedFields, command, mutationId, updatedAt: now, expiresAt: new Date(Date.parse(now) + DRAFT_TTL_MS).toISOString() };
          if (deviceRef.current.enabled) {
            await localChain.current;
            await deviceRef.current.put(payload as Draft);
            if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
            localRecord.current = payload as Draft; setLocalStatus('Original save details retained on this device');
          }
          const result = await request<{ status: 'saved'; draft: SavedDraft }>('/api/workspace/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: previous?.draftRevision ?? 0, draft: payload }) });
          if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
          record.current = result.draft; setHasRecord(true); setStatus('Draft saved separately');
        }).catch(error => { failure = error; });
        await chain.current;
        if (failure) throw failure;
      },
      async releaseSubmission() {
        const epoch = generation.current;
        clearTimeout(pendingTimer.current); clearTimeout(localTimer.current);
        let failure: unknown;
        chain.current = chain.current.then(async () => {
          if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
          const id = record.current?.id ?? identity.current.id;
          const result = await request<{ drafts: SavedDraft[] }>('/api/workspace/drafts');
          if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
          const previous = result.drafts.find(item => item.id === id);
          if (!previous) {
            if (deviceRef.current.enabled && localRecord.current) {
              const local = Object.fromEntries(Object.entries(localRecord.current).filter(([key]) => !['command', 'mutationId'].includes(key))) as Draft;
              await deviceRef.current.put(local);
              if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
              localRecord.current = local; setLocalStatus('Draft saved on this device');
            }
            return;
          }
          if (previous.mutationId && previous.mutationId !== attemptedMutation.current) throw new Error('The draft changed elsewhere. Reopen it before saving.');
          // Only the root may call this after proving that execution is impossible.
          // CAS preserves all newer content and refuses a competing save.
          const payload = Object.fromEntries(Object.entries(previous).filter(([key]) => !['command', 'mutationId', 'draftRevision'].includes(key)));
          const saved = await request<{ status: 'saved'; draft: SavedDraft }>('/api/workspace/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: previous.draftRevision, draft: payload }) });
          if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
          record.current = saved.draft; setHasRecord(true); setStatus('Draft saved separately');
          if (deviceRef.current.enabled && localRecord.current) {
            const local = Object.fromEntries(Object.entries(localRecord.current).filter(([key]) => !['command', 'mutationId'].includes(key))) as Draft;
            await deviceRef.current.put(local);
            if (generation.current !== epoch) throw new Error('Reopen this editor before saving.');
            localRecord.current = local; setLocalStatus('Draft saved on this device');
          }
        }).catch(error => { failure = error; });
        await chain.current;
        if (failure) throw failure;
      },
    };
    controllerRef.current = controller;
    return () => { if (controllerRef.current === controller) controllerRef.current = null; };
  }, [controllerRef, entityType, entityId]);

  const removeLocal = async (epoch: number) => {
    await localChain.current;
    const previous = localRecord.current;
    if (!previous || generation.current !== epoch || !deviceRef.current.enabled) return;
    const removed = await deviceRef.current.removeIfUnchanged(previous);
    if (removed && generation.current === epoch && localRecord.current === previous) { localRecord.current = null; setLocalStatus('Device copy cleared'); }
  };
  const remove = async (epoch: number) => {
    const previous = record.current;
    if (!previous) return;
    await request(`/api/workspace/drafts/${encodeURIComponent(previous.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: previous.draftRevision }) });
    if (generation.current === epoch && record.current === previous) { record.current = null; setHasRecord(false); }
  };
  const saved = async () => {
    const snapshot = current.current;
    const epoch = generation.current;
    clearTimeout(pendingTimer.current); clearTimeout(localTimer.current);
    await chain.current;
    if (generation.current !== epoch || JSON.stringify(current.current) !== JSON.stringify(snapshot)) return;
    try { await removeLocal(epoch); await remove(epoch); if (generation.current === epoch) setStatus(''); } catch (error) { if (generation.current === epoch) failure(error); }
  };
  const restore = () => {
    if (!recovery) return;
    identity.current = { id: recovery.id, baseRevision: recovery.baseRevision, createdAt: recovery.createdAt };
    setBaseline(recovery.baseSnapshot as T);
    setDraft({ ...recovery.baseSnapshot, ...recovery.changedFields } as T);
    onRecover?.({ baseRevision: recovery.baseRevision, command: recovery.command, mutationId: recovery.mutationId });
    setLocalRecovery([]); setRecovery(null); setStatus('Recovered draft. Review your changes before saving.');
  };
  const restoreLocal = (candidate: Draft) => {
    identity.current = { id: candidate.id, baseRevision: candidate.baseRevision, createdAt: candidate.createdAt };
    if (record.current?.id !== candidate.id) record.current = null;
    localRecord.current = candidate;
    setBaseline(candidate.baseSnapshot as T); setDraft({ ...candidate.baseSnapshot, ...candidate.changedFields } as T);
    onRecover?.({ baseRevision: candidate.baseRevision, command: candidate.command, mutationId: candidate.mutationId });
    setLocalRecovery([]); setRecovery(null); setLocalStatus('Recovered device draft. Review it before saving. Recovery did not submit anything.');
  };
  const discardLocal = async (candidate: Draft) => {
    const epoch = generation.current;
    try {
      const removed = await deviceRef.current.removeIfUnchanged(candidate);
      if (generation.current !== epoch) return;
      if (!removed) throw new Error('The device draft changed. Close and reopen to review it.');
      setLocalRecovery(previous => previous.filter(item => item !== candidate)); setLocalStatus('Selected device draft discarded');
    } catch { if (generation.current === epoch) setLocalStatus('Device draft could not be discarded. Close and reopen to review it.'); }
  };
  const discard = async () => {
    const snapshot = current.current;
    const epoch = generation.current;
    clearTimeout(pendingTimer.current); clearTimeout(localTimer.current);
    await chain.current;
    if (generation.current !== epoch) return;
    try {
      await removeLocal(epoch);
      await remove(epoch);
      if (generation.current !== epoch || JSON.stringify(current.current) !== JSON.stringify(snapshot)) return;
      setDraft(initial); setBaseline(initial); setRecovery(null); setStatus('Draft discarded');
    } catch (error) { if (generation.current === epoch) failure(error); }
  };
  const notice = <div aria-live="polite">{device.enabled && <p className="field-hint">{localStatus || 'Device drafts are unlocked; copies are saved separately.'}</p>}{localRecovery.map(candidate => <div className="capture-preview" key={candidate.id}><p>A device draft is available from {candidate.updatedAt}. It is separate from the workspace draft. Choose one version to review; versions are never merged automatically.</p><button type="button" className="text-button" onClick={() => restoreLocal(candidate)}>{!recovery && localRecovery.length === 1 ? 'Recover draft' : 'Recover device draft'}</button><button type="button" className="text-button" onClick={() => void discardLocal(candidate)}>Discard this device draft</button></div>)}{recovery ? <div className="capture-preview"><p>A saved draft is available. Recover it to review your earlier changes.</p><button type="button" className="text-button" onClick={restore}>{localRecovery.length ? 'Recover workspace draft' : 'Recover draft'}</button><button type="button" className="text-button" onClick={() => void discard()}>Discard saved draft</button></div> : <><p className="field-hint">{status}</p>{hasRecord && <button type="button" className="text-button" onClick={() => void discard()}>Discard draft changes</button>}</>}</div>;
  return { baseline, draft, setDraft, saved, notice };
}
