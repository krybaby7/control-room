'use client';

import { useState } from 'react';
import type { Capture, CaptureInput, Command, Horizon, Workspace } from '@/lib/types';
import { changedFields } from '@/lib/draft';
import { Field, FormDialog } from './form-dialog';

export function CaptureEditor({ capture, workspace, onSave, onClose }: { capture?: Capture; workspace: Workspace; onSave: (command: Command) => Promise<void>; onClose: () => void }) {
  const initial: CaptureInput & { status: Capture['status'] } = capture ? { title: capture.title, body: capture.body, projectId: capture.projectId, kind: capture.kind, sourceUrl: capture.sourceUrl, status: capture.status } : { title: '', body: '', projectId: null, kind: 'idea', sourceUrl: null, status: 'inbox' };
  const [baseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft(d => ({ ...d, [key]: value }));
  return <FormDialog title={capture ? 'Edit capture' : 'Get it out of your head'} subtitle="Catch the thought now. Give it a place when you’re ready." dirty={JSON.stringify(draft) !== JSON.stringify(baseline)} onClose={onClose} submitLabel={capture ? 'Save capture' : 'Capture it'} onSave={() => {
    if (capture) return onSave({ type: 'capture.update', id: capture.id, patch: changedFields(baseline, draft) });
    const { title, body, projectId, kind, sourceUrl } = draft;
    return onSave({ type: 'capture.create', capture: { title, body, projectId, kind, sourceUrl } });
  }}>
    <Field label="Title"><input autoFocus required maxLength={200} value={draft.title} onChange={e => set('title', e.target.value)} placeholder="An idea, next step, or decision…" /></Field>
    <Field label="Details"><textarea rows={5} maxLength={10000} value={draft.body} onChange={e => set('body', e.target.value)} placeholder="Leave enough context for your future self." /></Field>
    <div className="form-grid"><Field label="Project"><select value={draft.projectId ?? ''} onChange={e => set('projectId', e.target.value || null)}><option value="">Decide later</option>{workspace.projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field><Field label="Kind"><select value={draft.kind} onChange={e => set('kind', e.target.value as CaptureInput['kind'])}><option value="idea">Idea</option><option value="task">Task suggestion</option><option value="decision">Decision</option></select></Field></div>
    <Field label="Source link"><input type="url" maxLength={2048} value={draft.sourceUrl ?? ''} onChange={e => set('sourceUrl', e.target.value || null)} placeholder="https://…" /></Field>
    {capture && <Field label="Filing status" hint={capture.convertedTaskId ? 'This capture has already been converted. Its task stays linked.' : 'Keep it in your inbox, file it for reference, or archive it.'}><select value={draft.status} onChange={e => set('status', e.target.value as Capture['status'])}><option value="inbox">Inbox</option><option value="filed">Filed</option><option value="archived">Archived</option></select></Field>}
  </FormDialog>;
}

export function ConvertEditor({ capture, workspace, onSave, onClose }: { capture: Capture; workspace: Workspace; onSave: (command: Command) => Promise<void>; onClose: () => void }) {
  const [projectId, setProjectId] = useState(capture.projectId ?? '');
  const [milestoneId, setMilestoneId] = useState('');
  const [horizon, setHorizon] = useState<Horizon>('now');
  return <FormDialog title="Turn this into a task" subtitle="Its details and source link come with it. The capture stays linked." dirty={projectId !== (capture.projectId ?? '') || !!milestoneId || horizon !== 'now'} onClose={onClose} submitLabel="Create linked task" onSave={async () => {
    if (!projectId) throw new Error('Choose a project for this task.');
    await onSave({ type: 'capture.convert', id: capture.id, projectId, milestoneId: milestoneId || null, horizon });
  }}>
    <div className="capture-preview"><span className="eyebrow">FROM YOUR INBOX</span><h3>{capture.title}</h3>{capture.body && <p>{capture.body}</p>}</div>
    <Field label="Project"><select autoFocus required value={projectId} onChange={e => { setProjectId(e.target.value); setMilestoneId(''); }}><option value="">Choose a project</option>{workspace.projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>
    <div className="form-grid"><Field label="Milestone"><select value={milestoneId} onChange={e => setMilestoneId(e.target.value)}><option value="">No milestone</option>{workspace.milestones.filter(m => m.projectId === projectId).map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Horizon"><select value={horizon} onChange={e => setHorizon(e.target.value as Horizon)}><option value="now">Now</option><option value="next">Next</option><option value="later">Later</option></select></Field></div>
  </FormDialog>;
}
