'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronDown, FolderOpen, Inbox, LayoutGrid, LoaderCircle, LogOut, Plus, Radio, RefreshCw, Sun, X } from 'lucide-react';
import type { Capture, Command, Milestone, Project, Task, WorkspaceEnvelope } from '@/lib/types';
import { TaskEditor } from './task-editor';
import { MilestoneEditor, ProjectEditor } from './planning-editors';
import { CaptureEditor, ConvertEditor } from './capture-editors';
import { TodayView } from './today-view';
import { ProjectDetail, ProjectsView } from './projects-view';
import { InboxView } from './inbox-view';
import { SourcesView } from './sources-view';

type View = 'today' | 'projects' | 'inbox' | 'sources';
type ApiResponse = Partial<WorkspaceEnvelope> & { error?: string };
type Editor = { type: 'task'; task?: Task; projectId: string } | { type: 'milestone'; milestone?: Milestone; project: Project } | { type: 'project'; project: Project } | { type: 'capture'; capture?: Capture } | { type: 'convert'; capture: Capture };
const navItems = [{ id: 'today', label: 'Today', icon: Sun }, { id: 'projects', label: 'Projects', icon: LayoutGrid }, { id: 'inbox', label: 'Inbox', icon: Inbox }, { id: 'sources', label: 'Sources', icon: FolderOpen }] as const;

export default function ControlCenter({ userName }: { userName: string }) {
  const [envelope, setEnvelope] = useState<WorkspaceEnvelope | null>(null);
  const envelopeRef = useRef<WorkspaceEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>('today');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorBaseRef = useRef<{ revision: number } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const acceptEnvelope = useCallback((next: WorkspaceEnvelope) => { if (envelopeRef.current && next.revision < envelopeRef.current.revision) return; envelopeRef.current = next; setEnvelope(next); }, []);
  const read = useCallback(async () => {
    const response = await fetch('/api/workspace', { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json().catch(() => null) as ApiResponse | null;
    if (!response.ok) throw new Error(body?.error ?? 'Your workspace could not be loaded. Check your connection and try again.');
    if (!body?.workspace || typeof body.revision !== 'number') throw new Error('The workspace response was incomplete. Please try again.');
    acceptEnvelope(body as WorkspaceEnvelope);
    return envelopeRef.current!;
  }, [acceptEnvelope]);
  const refresh = useCallback(async () => { if (busyRef.current) return; setError(''); setLoading(true); try { await read(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your workspace could not be loaded.'); } finally { setLoading(false); } }, [read]);
  useEffect(() => {
    void read().catch(cause => setError(cause instanceof Error ? cause.message : 'Your workspace could not be loaded.')).finally(() => setLoading(false));
  }, [read]);
  useEffect(() => { const onFocus = () => { if (!busyRef.current) void read().catch(() => {}); }; window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus); }, [read]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4500); return () => window.clearTimeout(timer); }, [notice]);
  async function mutate(command: Command, editorBase?: { revision: number }) {
    if (!envelopeRef.current) throw new Error('Load your workspace before saving.');
    if (busyRef.current) throw new Error('Another change is saving. Please try again in a moment.');
    busyRef.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/workspace', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: editorBase?.revision ?? envelopeRef.current.revision, command }) });
      const body = await response.json().catch(() => null) as ApiResponse | null;
      if (response.status === 409) {
        try {
          const latest = await read();
          // Only a reported conflict advances the draft, so the next save is an explicit retry.
          if (editorBase) editorBase.revision = latest.revision;
        } catch { throw new Error('This workspace changed in another session, and the latest version could not be loaded. Your draft is safe. Check your connection and try saving again.'); }
        throw new Error('This workspace changed in another session. The latest version is loaded and your draft is still here. Review your changes, then save again.');
      }
      if (!response.ok) throw new Error(body?.error ?? 'This change could not be saved. Your draft is still here. Please try again.');
      if (!body?.workspace || typeof body.revision !== 'number') throw new Error('The save response was incomplete. Refresh to check whether your change was saved before retrying.');
      acceptEnvelope(body as WorkspaceEnvelope); setNotice('Saved to your workspace');
    } finally { busyRef.current = false; setBusy(false); }
  }
  const run = (command: Command) => { void mutate(command).catch(cause => setError(cause instanceof Error ? cause.message : 'This change could not be saved.')); };
  const openEditor = (next: Editor) => {
    if (!envelope) return;
    // Use the displayed snapshot, even if an in-flight read has already updated the ref.
    editorBaseRef.current = { revision: envelope.revision };
    setEditor(next);
  };
  const closeEditor = () => { editorBaseRef.current = null; setEditor(null); };
  const saveEditor = (command: Command) => {
    if (!editorBaseRef.current) return Promise.reject(new Error('Reopen this editor before saving.'));
    return mutate(command, editorBaseRef.current);
  };
  const navigate = (next: View) => { setView(next); setProjectId(null); setAccountOpen(false); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const openProject = (project: Project) => { setView('projects'); setProjectId(project.id); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const openTask = (task: Task) => openEditor({ type: 'task', task, projectId: task.projectId });
  const pinTask = (task: Task) => run({ type: 'task.update', id: task.id, patch: { weekly: !task.weekly } });
  const workspace = envelope?.workspace;
  const project = workspace?.projects.find(p => p.id === projectId);
  const inboxCount = workspace?.captures.filter(c => c.status === 'inbox').length ?? 0;
  const name = userName?.trim() || 'Your workspace';
  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to workspace</a>
    <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('today'); }} aria-label="Control Room home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span><strong>Control Room</strong><small>Your project workspace</small></span></a><div className="workspace-caption">WORKSPACE</div><nav className="main-nav" aria-label="Main navigation">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''} ${id === 'inbox' ? 'nav-secondary-start' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{id === 'inbox' && inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}</button>)}</nav><button className="sidebar-capture" onClick={() => openEditor({ type: 'capture' })} disabled={!workspace}><Plus size={17} />Quick capture</button><div className="sidebar-bottom"><div className="private-label"><span />Private workspace</div>{accountOpen && <a className="signout-link" href="/signout-with-chatgpt?return_to=%2F"><LogOut size={15} />Sign out</a>}<button className="account-button" onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen} aria-label="Account menu"><span className="avatar">{name.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{name}</strong><small>Personal workspace</small></span><ChevronDown size={15} /></button></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">Workspace<span>/</span><strong>{navItems.find(item => item.id === view)?.label}{project ? ` / ${project.name}` : ''}</strong></div><div className="sync-indicator" role="status">{busy || loading ? <LoaderCircle className="spinning" size={13} /> : envelope ? <Check size={13} /> : <Radio size={13} />}<span>{busy ? 'Saving…' : loading ? 'Loading…' : envelope ? 'Saved workspace' : 'Not loaded'}</span></div></header><main id="main-content" tabIndex={-1}>
      {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{error}</span><button className="text-button" onClick={() => void refresh()} disabled={busy || loading}><RefreshCw size={14} />Retry</button><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      {!workspace ? <div className="loading-screen">{loading ? <><LoaderCircle size={30} className="spinning" /><h1>A little clarity is on its way.</h1><p>Loading your private workspace…</p></> : <><AlertCircle size={30} /><h1>Your workspace is waiting.</h1><p>We couldn’t load it. Your saved work has not been changed.</p><button className="button primary" onClick={() => void refresh()}>Try again<ArrowRight size={16} /></button></>}</div> : <>
        {view === 'today' && <TodayView workspace={workspace} onProject={openProject} onTask={openTask} onPin={pinTask} onProjects={() => navigate('projects')} onCapture={() => openEditor({ type: 'capture' })} busy={busy} />}
        {view === 'projects' && (project ? <ProjectDetail key={project.id} project={project} workspace={workspace} busy={busy} onBack={() => setProjectId(null)} onProjectEdit={() => openEditor({ type: 'project', project })} onMilestone={milestone => openEditor({ type: 'milestone', milestone, project })} onNewMilestone={() => openEditor({ type: 'milestone', project })} onTask={openTask} onNewTask={() => openEditor({ type: 'task', projectId: project.id })} onPin={pinTask} /> : <ProjectsView workspace={workspace} onProject={openProject} />)}
        {view === 'inbox' && <InboxView workspace={workspace} busy={busy} onCreate={() => openEditor({ type: 'capture' })} onEdit={capture => openEditor({ type: 'capture', capture })} onConvert={capture => openEditor({ type: 'convert', capture })} onTask={openTask} onCommand={run} />}
        {view === 'sources' && envelope && <SourcesView envelope={envelope} busy={busy || loading} onRefresh={() => void refresh()} />}
      </>}
    </main><footer className="app-footer"><span>CONTROL ROOM</span><span>A little clarity. A steady next step.</span></footer></div>
    {notice && <div className="save-toast" role="status"><Check size={16} />{notice}</div>}
    {workspace && editor?.type === 'task' && <TaskEditor task={editor.task} projectId={editor.projectId} workspace={workspace} onSave={saveEditor} onClose={closeEditor} />}
    {workspace && editor?.type === 'milestone' && <MilestoneEditor milestone={editor.milestone} project={editor.project} onSave={saveEditor} onClose={closeEditor} />}
    {workspace && editor?.type === 'project' && <ProjectEditor project={editor.project} onSave={saveEditor} onClose={closeEditor} />}
    {workspace && editor?.type === 'capture' && <CaptureEditor capture={editor.capture} workspace={workspace} onSave={saveEditor} onClose={closeEditor} />}
    {workspace && editor?.type === 'convert' && <ConvertEditor capture={editor.capture} workspace={workspace} onSave={saveEditor} onClose={closeEditor} />}
  </div>;
}
