'use client';

import type { Command, Milestone, MilestoneInput, Project } from '@/lib/types';
import { useDurableDraft } from './durable-draft';
import { changedFields } from '@/lib/draft';
import { Field, FormDialog } from './form-dialog';

export function ProjectEditor({ project, onSave, onClose }: { project: Project; onSave: (command: Command) => Promise<void>; onClose: () => void }) {
  const { baseline, draft, setDraft, saved, notice } = useDurableDraft('project', project.id, { description: project.description, goal: project.goal });
  return <FormDialog title={`The goal for ${project.name}`} subtitle="Your definition of a meaningful outcome." dirty={draft.description !== baseline.description || draft.goal !== baseline.goal} onClose={onClose} onSave={async () => { await onSave({ type: 'project.update', id: project.id, patch: changedFields(baseline, draft) }); await saved(); }}>
    {notice}
    <Field label="Project goal" hint="Describe the outcome, including the constraints that matter."><textarea autoFocus required rows={5} maxLength={5000} value={draft.goal} onChange={e => setDraft(d => ({ ...d, goal: e.target.value }))} /></Field>
    <Field label="Description"><textarea rows={4} maxLength={5000} value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} /></Field>
  </FormDialog>;
}

export function MilestoneEditor({ milestone, project, onSave, onClose }: { milestone?: Milestone; project: Project; onSave: (command: Command) => Promise<void>; onClose: () => void }) {
  const initial: MilestoneInput = milestone ? { projectId: milestone.projectId, title: milestone.title, description: milestone.description, acceptance: milestone.acceptance, status: milestone.status, targetDate: milestone.targetDate, evidence: milestone.evidence } : { projectId: project.id, title: '', description: '', acceptance: '', status: 'planned', targetDate: null, evidence: '' };
  const { baseline, draft, setDraft, saved, notice } = useDurableDraft('milestone', milestone?.id ?? `new:${project.id}`, initial);
  const set = <K extends keyof MilestoneInput>(key: K, value: MilestoneInput[K]) => setDraft(d => ({ ...d, [key]: value }));
  return <FormDialog title={milestone ? 'Edit milestone' : 'Define a milestone'} subtitle={`A meaningful outcome for ${project.name}.`} dirty={JSON.stringify(draft) !== JSON.stringify(baseline)} onClose={onClose} submitLabel={milestone ? 'Save milestone' : 'Create milestone'} onSave={async () => { await onSave(milestone ? { type: 'milestone.update', id: milestone.id, patch: changedFields(baseline, draft) } : { type: 'milestone.create', milestone: draft }); await saved(); }}>
    {notice}
    <Field label="Milestone title"><input autoFocus required maxLength={200} value={draft.title} onChange={e => set('title', e.target.value)} placeholder="What should be true at the end?" /></Field>
    <Field label="Description"><textarea rows={3} maxLength={5000} value={draft.description} onChange={e => set('description', e.target.value)} /></Field>
    <Field label="Acceptance criteria" hint="Make the finish line explicit: what will you check?"><textarea required rows={4} maxLength={5000} value={draft.acceptance} onChange={e => set('acceptance', e.target.value)} placeholder="This milestone is achieved when…" /></Field>
    <div className="form-grid"><Field label="Status"><select value={draft.status} onChange={e => set('status', e.target.value as MilestoneInput['status'])}><option value="planned">Planned</option><option value="active">Active</option><option value="achieved">Achieved</option></select></Field><Field label="Target date"><input type="date" value={draft.targetDate ?? ''} onChange={e => set('targetDate', e.target.value || null)} /></Field></div>
    <Field label="Acceptance evidence" hint={draft.status === 'achieved' ? 'Required to record this milestone as achieved.' : 'Add verification notes or links when the outcome is ready.'}><textarea required={draft.status === 'achieved'} rows={4} maxLength={5000} value={draft.evidence} onChange={e => set('evidence', e.target.value)} /></Field>
  </FormDialog>;
}
