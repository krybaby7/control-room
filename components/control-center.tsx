'use client';
import {AttachmentReserveEditor,AttachmentUploadDialog,AttachmentLifecycleDialog} from './attachment-dialogs';
import {EvidenceLinkEditor} from './evidence-link-editor';
import {RequirementEditor} from './requirement-editor';
import {AcceptanceDialog} from './acceptance-dialog';
import {DecisionActionDialog} from './decision-action-dialog';
import type {AttachmentSnapshot,EvidenceSnapshot} from '@/lib/evidence-store';
import {HistoryView} from './history-view';
import {EvidenceWorkspace} from './evidence-workspace';
import {EvidenceEditor} from './evidence-editor';
import {DecisionEditor} from './decision-editor';
import type {EvidenceVersion,DecisionVersion,EvidenceRequirement,EvidenceSubject} from '@/lib/evidence-contract';
import {DEFAULT_SEARCH_STATE,encodeSearchState,parseSearchState,type SearchState} from '@/lib/planning-search-state';
import {weekStartSchema} from '@/lib/weekly-planning';
import {OriginalSaveContext} from './form-dialog';
import {TaskBulkActions} from './task-bulk-actions';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronDown, FolderOpen, Inbox, LayoutGrid, LoaderCircle, LogOut, Plus, Radio, RefreshCw, Search, ListChecks, CalendarDays, Sun, X } from 'lucide-react';
import type { Capture, Command, Milestone, Project, Task, Workspace, WorkspaceEnvelope } from '@/lib/types';
import { isCurrentWeek } from '@/lib/calendar';
import { readWorkspaceResponse, SessionExpiredError, WorkspaceRequestError, isConclusiveWorkspaceRejection, submissionFor, type Submission } from '@/lib/workspace-client';
import { boundedRequest, issueSubmissionId, sendCommand, reconcileSubmission, SaveSessionGeneration, StaleSessionError } from '@/lib/save-controller';
import { DurableDraftProvider, type DurableDraftController, type RecoveredSubmission } from './durable-draft';
import {WeeklyReviewEditor,type WeeklyReviewDraft} from './weekly-review-editor';
import { WeeklyPlanningView } from './weekly-planning-view';
import { RecurrenceEditor } from './recurrence-editor';
import type { RecurrenceRule } from '@/lib/recurrence';
import { WorkspacePolling } from '@/lib/workspace-polling';
import { DeviceDraftProvider, type DeviceDraftController } from './device-drafts';
import { SessionExpiredContext } from './session-state';
import { TaskEditor } from './task-editor';
import { PortfolioProjectEditor } from './project-editor';
import { MilestoneWorkspace } from './milestone-workspace';
import { SearchView } from './search-view';
import {ReviewAttentionResults} from './review-attention-results';
import { AttentionView } from './attention-view';
import { entityHref, parseEntityLink, type EntityTarget } from '@/lib/entity-links';
import {parseReviewLink,reviewHref,type ReviewTarget} from '@/lib/review-links';
import {ReviewCitation} from './review-citation';
import {parseEvidenceSubjectLink,resolveEvidenceSubject} from '@/lib/evidence-subject-links';
import { MilestoneEditor } from './planning-editors';
import { CaptureEditor, ConvertEditor } from './capture-editors';
import { TodayView } from './today-view';
import { ProjectDetail, ProjectsView } from './projects-view';
import { InboxView } from './inbox-view';
import { SourcesView } from './sources-view';

type View = 'today' | 'projects' | 'inbox' | 'sources' | 'search' | 'attention' | 'weekly' | 'evidence' | 'history';
type SaveBase = { revision: number; submission?: Submission | null };
type Editor = {type:'attachment-reserve';snapshot:EvidenceSnapshot}|{type:'attachment-upload';attachment:AttachmentSnapshot;snapshot:EvidenceSnapshot}|{type:'attachment-lifecycle';attachment:AttachmentSnapshot;snapshot:EvidenceSnapshot;action:'finalize'|'retire'}|{type:'evidence';evidence?:EvidenceVersion;snapshot?:EvidenceSnapshot}|{type:'decision';decision?:DecisionVersion;snapshot?:EvidenceSnapshot}|{type:'evidence-link';evidence:EvidenceVersion;snapshot:EvidenceSnapshot;subject?:EvidenceSubject}|{type:'requirement';requirement?:{value:EvidenceRequirement;rowRevision:number};snapshot:EvidenceSnapshot;subject?:EvidenceSubject}|{type:'acceptance';snapshot:EvidenceSnapshot;subject?:EvidenceSubject}|{type:'decision-action';decision:DecisionVersion;snapshot:EvidenceSnapshot;action:'decide'|'supersede'}|{ type: 'task'; task?: Task; projectId: string; milestoneId?:string } | { type: 'milestone'; milestone?: Milestone; project: Project } | { type: 'project'; project?: Project } | { type: 'capture'; capture?: Capture } | { type: 'convert'; capture: Capture } | {type:'recurrence';rule?:{value:RecurrenceRule;rowRevision:number}} | {type:'weekly-review';draft:WeeklyReviewDraft};
const navItems = [{ id: 'today', label: 'Today', icon: Sun }, { id: 'projects', label: 'Projects', icon: LayoutGrid }, { id: 'inbox', label: 'Inbox', icon: Inbox }, {id:'weekly',label:'Weekly planning',icon:CalendarDays}, { id: 'search', label: 'Search', icon: Search }, { id: 'attention', label: 'Attention', icon: ListChecks }, { id: 'history', label: 'History', icon: FolderOpen }, { id: 'evidence', label: 'Evidence & decisions', icon: ListChecks }, { id: 'sources', label: 'Sources', icon: FolderOpen }] as const;

export default function ControlCenter({ userName }: { userName: string }) {
  const [envelope, setEnvelope] = useState<WorkspaceEnvelope | null>(null);
  const envelopeRef = useRef<WorkspaceEnvelope | null>(null);
  const sessionGeneration = useRef(new SaveSessionGeneration());
  const polling=useRef<WorkspacePolling<WorkspaceEnvelope>|null>(null);
  const readFlight=useRef<Promise<WorkspaceEnvelope>|null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expired, setExpired] = useState(false);
  const expiredRef = useRef(false);
  const [stale, setStale] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const editorDraftController=useRef<DurableDraftController|null>(null);
  const deviceDraftController=useRef<DeviceDraftController|null>(null);
  const [unresolved,setUnresolved]=useState<{submission:Submission;command:Command}[]>([]);
  const directSubmission = useRef<Submission | null>(null);
  const [pendingDirectCommand, setPendingDirectCommand] = useState<Command | null>(null);
  const [view, setView] = useState<View>('today');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [milestoneId,setMilestoneId]=useState<string|null>(null);
  const [unavailableTarget,setUnavailableTarget]=useState(false);
  const locationKey=useRef<string|null>(null);
  const [editorRevision,setEditorRevision]=useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [searchState,setSearchState]=useState<SearchState>({...DEFAULT_SEARCH_STATE});
  const [weeklyWeek,setWeeklyWeek]=useState<string|undefined>();
  const [editorSubmissionId,setEditorSubmissionId]=useState<string|null>(null);
  const editorBaseRef = useRef<SaveBase | null>(null);
  const editorReturnLocation=useRef<string|null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const expireSession = useCallback(() => { polling.current?.setSignedIn(false);sessionGeneration.current.invalidate(); expiredRef.current = true; envelopeRef.current = null; editorBaseRef.current = null; directSubmission.current = null; setEnvelope(null); setEditor(null); setPendingDirectCommand(null); setUnresolved([]); setExpired(true); setNotice(''); setError(''); }, []);
  useEffect(()=>{window.addEventListener('control-room-session-expired',expireSession);return ()=>window.removeEventListener('control-room-session-expired',expireSession);},[expireSession]);
  const signOut = async () => {
    expireSession();
    try { await deviceDraftController.current?.forget(); }
    finally {
      // The authentication gateway requires a full document navigation.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/signout-with-chatgpt?return_to=%2F');
    }
  };
  const acceptEnvelope = useCallback((next: WorkspaceEnvelope) => { if (expiredRef.current || (envelopeRef.current && next.revision < envelopeRef.current.revision)) return; envelopeRef.current = next;polling.current?.observeRevision(next.revision);setEnvelope(next); }, []);
  const requestCurrent=useCallback(async()=>{
    if(expiredRef.current)throw new SessionExpiredError();
    if(readFlight.current)return readFlight.current;
    const flight=boundedRequest('/api/workspace',{credentials:'same-origin',cache:'no-store'},readWorkspaceResponse,{session:sessionGeneration.current});readFlight.current=flight;
    try{return await flight;}finally{if(readFlight.current===flight)readFlight.current=null;}
  },[]);
  const read=useCallback(async(forceAfterFlight=false)=>{
    if(expiredRef.current)throw new SessionExpiredError();
    try{if(forceAfterFlight&&readFlight.current)await readFlight.current;const next=await requestCurrent();if(expiredRef.current)throw new SessionExpiredError();acceptEnvelope(next);setStale(false);setError('');setLastRefreshed(new Date().toISOString());return envelopeRef.current!;}
    catch(cause){if(cause instanceof SessionExpiredError)expireSession();else setStale(true);throw cause;}
  },[acceptEnvelope,expireSession,requestCurrent]);
  const refresh = useCallback(async () => { if (busyRef.current) return; setError(''); setLoading(true); try { await read(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your workspace could not be loaded.'); } finally { setLoading(false); } }, [read]);
  useEffect(()=>{
    const coordinator=new WorkspacePolling<WorkspaceEnvelope>({read:requestCurrent,accept:next=>{if(expiredRef.current)return;acceptEnvelope(next);setStale(false);setError('');setLastRefreshed(new Date().toISOString());setLoading(false);},onExpire:expireSession,onError:cause=>{if(expiredRef.current)return;setStale(true);setError(cause instanceof Error?cause.message:'Refresh failed. The saved view may be out of date.');setLoading(false);},visible:document.visibilityState!=='hidden',signedIn:!expiredRef.current,busy:busyRef.current,initialRevision:envelopeRef.current?.revision??0});polling.current=coordinator;
    const focus=()=>coordinator.focus(),online=()=>coordinator.online(),visibility=()=>coordinator.setVisible(document.visibilityState!=='hidden');window.addEventListener('focus',focus);window.addEventListener('online',online);document.addEventListener('visibilitychange',visibility);coordinator.start();
    return()=>{coordinator.dispose();if(polling.current===coordinator)polling.current=null;window.removeEventListener('focus',focus);window.removeEventListener('online',online);document.removeEventListener('visibilitychange',visibility);};
  },[requestCurrent,acceptEnvelope,expireSession]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4500); return () => window.clearTimeout(timer); }, [notice]);
  async function mutate(command: Command, editorBase?: SaveBase, expectedRevision?:number) {
    if (expiredRef.current) throw new SessionExpiredError();
    if (!envelopeRef.current) throw new Error('Load your workspace before saving.');
    if (busyRef.current) throw new Error('Another change is saving. Please try again in a moment.');
    busyRef.current = true;polling.current?.setBusy(true);setBusy(true); setError('');
    const previous=editorBase?editorBase.submission:directSubmission.current;
    let submission = submissionFor(previous ?? null, command);
    try {
      if(!previous)submission={key:submission.key,mutationId:await issueSubmissionId({session:sessionGeneration.current})};
      if(previous && previous.key!==submission.key){
        const original=await reconcileSubmission(previous.mutationId,{session:sessionGeneration.current});
        if(original.status==='committed'){await read();if(!editorBase)directSubmission.current=null;setUnresolved(items=>items.filter(item=>item.submission.mutationId!==previous.mutationId));throw new Error('The original change saved. Its submission remains attached to this editor. Close it and review the saved plan before starting a different change.');}
        throw new Error('An earlier submission is still unresolved. Check the original save before replacing it with a changed submission.');
      }
      if(previous && previous.key===submission.key){
        const original=await reconcileSubmission(previous.mutationId,{session:sessionGeneration.current});
        if(original.status==='committed'){await read();if(editorBase)editorBase.submission=null;else directSubmission.current=null;setUnresolved(items=>items.filter(item=>item.submission.mutationId!==previous.mutationId));setNotice('Original change confirmed in the saved plan');return;}
        if(original.status!=='not-found')throw new Error('The original outcome could not be resolved. Check the original save before retrying.');
      }
      if (editorBase){editorBase.submission = submission;setEditorSubmissionId(submission.mutationId);}else directSubmission.current = submission;
      if(editorBase){try{const controller=editorDraftController.current;if(!controller)throw new Error('This editor is still preparing its recovery state. Keep it open and try again.');await controller.preserveSubmission(command,submission.mutationId);}catch(cause){await editorDraftController.current?.releaseSubmission();editorBase.submission=null;throw cause;}}
      if(expiredRef.current)throw new SessionExpiredError();
      const generation=sessionGeneration.current.capture();
      let next: WorkspaceEnvelope;
      try {
        next=await sendCommand({revision:editorBase?.revision ?? expectedRevision ?? envelopeRef.current.revision,mutationId:submission.mutationId,command},{session:sessionGeneration.current,generation});
      } catch(cause) {
        if(cause instanceof SessionExpiredError){expireSession();throw cause;}
        if(cause instanceof StaleSessionError)throw cause;
        if(cause instanceof WorkspaceRequestError && cause.status===409 && isConclusiveWorkspaceRejection(cause)){
          if(cause.diagnostic==='revision_conflict'||cause.diagnostic==='module_conflict'){if(editorBase){await editorDraftController.current?.releaseSubmission();editorBase.submission=null;}else directSubmission.current=null;}
          const latest=await read(true);
          if(editorBase)editorBase.revision=latest.revision;
          throw new Error('This workspace changed in another session. The latest version is loaded and your draft is still here. Review your changes, then save again.');
        }
        if(isConclusiveWorkspaceRejection(cause)){if(editorBase){await editorDraftController.current?.releaseSubmission();editorBase.submission=null;}else directSubmission.current=null;throw cause;}
        let outcome;
        try {outcome=await reconcileSubmission(submission.mutationId,{session:sessionGeneration.current,generation});}
        catch(reconcileError){if(reconcileError instanceof SessionExpiredError)expireSession();throw reconcileError;}
        if(outcome.status==='retired')throw new Error('This submission has retired. Review the authoritative plan before starting a new change.');
        if(outcome.status!=='committed'){setUnresolved(items=>items.some(item=>item.submission.mutationId===submission.mutationId)?items:[...items,{submission,command}]);throw new Error('The save is still unconfirmed. Your draft and original submission are retained. Retry the unchanged change after checking the connection.');}
        next=await read(true);
      }
      if (expiredRef.current) throw new SessionExpiredError();
      acceptEnvelope(next);setStale(false);setError('');setLastRefreshed(new Date().toISOString());
      if (editorBase) editorBase.submission = null; else directSubmission.current = null;
      setUnresolved(items=>items.filter(item=>item.submission.mutationId!==submission.mutationId));
      setNotice('Saved to your workspace');
    } finally { busyRef.current = false;polling.current?.setBusy(false);setBusy(false); }
  }
  async function loadPreviousBackup() {
    try { return await boundedRequest('/api/workspace?backup=previous', { credentials: 'same-origin', cache: 'no-store' },readWorkspaceResponse,{session:sessionGeneration.current}); }
    catch (cause) { if (cause instanceof SessionExpiredError) expireSession(); throw cause; }
  }
  const recoverSubmission=(draft:RecoveredSubmission)=>{if(!editorBaseRef.current)return;editorBaseRef.current.revision=draft.baseRevision;setEditorRevision(draft.baseRevision);if(draft.command && draft.mutationId){editorBaseRef.current.submission=submissionFor(null,draft.command,()=>draft.mutationId!);setEditorSubmissionId(draft.mutationId);}};
  const checkOriginal=async(item:{submission:Submission;command:Command}):Promise<string>=>{try{
    const result=await reconcileSubmission(item.submission.mutationId,{session:sessionGeneration.current});
    if(result.status==='committed'){
      await read();setUnresolved(items=>items.filter(value=>value!==item));
      if(directSubmission.current?.mutationId===item.submission.mutationId)directSubmission.current=null;
      setPendingDirectCommand(command=>command&&submissionFor(null,command).key===item.submission.key?null:command);
      const message=editorBaseRef.current?.submission?.mutationId===item.submission.mutationId?'Original change confirmed. Save the unchanged editor to acknowledge it, or close it before starting another change.':'Original change confirmed in the saved plan';setNotice(message);return message;
    }
    const message='The original save is still unresolved. It may complete later. Keep the original submission until its outcome is known.';setError(message);return message;
  }catch(cause){if(cause instanceof SessionExpiredError)expireSession();const message='The original save could not be checked.';setError(message);return message;}};
  const restoreWorkspace = async (workspace: Workspace, base: SaveBase) => { await mutate({ type: 'workspace.restore', workspace }, base); await refresh(); };
  const run = (command: Command) => {
    if (busyRef.current) return;
    // A new explicit intent replaces the previous retry offer. The exact failed
    // command is retained, so a refreshed toggle cannot invert a retry's intent.
    setPendingDirectCommand(null);
    void mutate(command).catch(cause => {
      if (!(cause instanceof SessionExpiredError)) setPendingDirectCommand(command);
      setError(cause instanceof Error ? cause.message : 'This change could not be saved.');
    });
  };
  const openEditor = (next: Editor,sourceRevision?:number) => {
    if (!envelope) return;
    // Use the displayed snapshot, even if an in-flight read has already updated the ref.
    editorBaseRef.current = { revision: sourceRevision??envelope.revision };setEditorRevision(sourceRevision??envelope.revision);
    editorReturnLocation.current=window.location.pathname+window.location.search;setEditorSubmissionId(null);setEditor(next);
  };
  const closeEditor = () => {
    editorBaseRef.current=null;setEditorSubmissionId(null);setEditor(null);
    const target=view==='search'?encodeSearchState(searchState):editorReturnLocation.current??(view==='projects'&&projectId?entityHref({kind:'project',id:projectId}):`/?view=${view}`);
    editorReturnLocation.current=null;window.history.replaceState({},'',target);locationKey.current=window.location.search;
  };
  const saveEditor = (command: Command) => {
    if (!editorBaseRef.current) return Promise.reject(new Error('Reopen this editor before saving.'));
    return mutate(command, editorBaseRef.current);
  };
  const [evidenceSubject,setEvidenceSubject]=useState<EvidenceSubject|undefined>();
  const [reviewTarget,setReviewTarget]=useState<ReviewTarget|null>(null);
  const mayNavigate=()=>{if(busyRef.current){setError('Wait for the current save outcome before leaving this editor.');return false;}return !editorDraftController.current?.isDirty()||window.confirm('Leave this editor? Unsaved changes may be discarded. Saved draft copies remain available.');};
  const writeLocation=(url:string)=>{window.history.pushState({},'',url);locationKey.current=window.location.search;};
  const navigate = (next: View) => { if(!mayNavigate())return;closeEditor();setReviewTarget(null);setEvidenceSubject(undefined);setView(next);setProjectId(null);setMilestoneId(null);setUnavailableTarget(false);setAccountOpen(false);writeLocation(next==='search'?encodeSearchState(searchState):`/?view=${next}`);if(next==='weekly')setWeeklyWeek(undefined);window.scrollTo({ top: 0, behavior: 'instant' }); };
  const openProject = (project: Project) => {if(!mayNavigate())return;closeEditor();setReviewTarget(null);setEvidenceSubject(undefined);setView('projects');setProjectId(project.id);setMilestoneId(null);setUnavailableTarget(false);writeLocation(entityHref({kind:'project',id:project.id}));window.scrollTo({top:0,behavior:'instant'});};
  const openMilestone=(milestone:Milestone)=>{if(!mayNavigate())return;closeEditor();setReviewTarget(null);setEvidenceSubject(undefined);setView('projects');setProjectId(milestone.projectId);setMilestoneId(milestone.id);setUnavailableTarget(false);writeLocation(entityHref({kind:'milestone',id:milestone.id}));window.scrollTo({top:0,behavior:'instant'});};
  const openTask = (task: Task) => {if(!mayNavigate())return;openEditor({ type: 'task', task, projectId: task.projectId });writeLocation(entityHref({kind:'task',id:task.id}));};
  const openEntity=(target:EntityTarget)=>{const ws=envelopeRef.current?.workspace;if(!ws)return;if(target.kind==='project'){const row=ws.projects.find(row=>row.id===target.id);if(row)openProject(row);}else if(target.kind==='milestone'){const row=ws.milestones.find(row=>row.id===target.id);if(row)openMilestone(row);}else if(target.kind==='task'){const row=ws.tasks.find(row=>row.id===target.id);if(row)openTask(row);}else{const row=ws.captures.find(row=>row.id===target.id);if(row&&mayNavigate()){setView('inbox');openEditor({type:'capture',capture:row});writeLocation(entityHref(target));}}};
  useEffect(()=>{
    if(!envelope||expired)return;
    let active=true;const apply=(force=false)=>{if(!active||expiredRef.current||envelopeRef.current!==envelope)return;const key=window.location.search;if(!force&&locationKey.current===key)return;if(busyRef.current){window.history.pushState({},'',`/${locationKey.current??''}`);setError('Wait for the current save outcome before leaving this editor.');return;}if(editorDraftController.current?.isDirty()&&!window.confirm('Leave this editor? Unsaved changes may be discarded. Saved draft copies remain available.')){window.history.pushState({},'',`/${locationKey.current??''}`);return;}locationKey.current=key;const params=new URLSearchParams(key);setEditor(null);setEditorSubmissionId(null);editorBaseRef.current=null;editorReturnLocation.current=null;setMilestoneId(null);setProjectId(null);setReviewTarget(null);setEvidenceSubject(undefined);setUnavailableTarget(false);
      if(params.has('review')){const result=parseReviewLink(params);if(result.status==='unavailable'){setUnavailableTarget(true);return;}setReviewTarget(result.target);setView(result.target.kind==='history'?'history':'evidence');}
      else if(params.has('subject')){const parsed=parseEvidenceSubjectLink(params);if(parsed.status==='unavailable'||resolveEvidenceSubject(envelope.workspace,parsed.target).status==='unavailable'){setUnavailableTarget(true);return;}setEvidenceSubject(parsed.target);setView('evidence');}
      else if(params.has('entity')){const result=parseEntityLink(params,envelope.workspace);if(result.status==='unavailable'){setUnavailableTarget(true);return;}const target=result.target;setView(target.kind==='capture'?'inbox':'projects');if(target.kind==='project')setProjectId(target.id);else if(target.kind==='milestone'){const row=envelope.workspace.milestones.find(row=>row.id===target.id)!;setProjectId(row.projectId);setMilestoneId(row.id);}else if(target.kind==='task'){const row=envelope.workspace.tasks.find(row=>row.id===target.id)!;setProjectId(row.projectId);editorBaseRef.current={revision:envelope.revision};setEditorRevision(envelope.revision);setEditor({type:'task',task:row,projectId:row.projectId});}else{const row=envelope.workspace.captures.find(row=>row.id===target.id)!;editorBaseRef.current={revision:envelope.revision};setEditorRevision(envelope.revision);setEditor({type:'capture',capture:row});}}
      else{const next=params.get('view');if(next&&navItems.some(item=>item.id===next)){setView(next as View);if(next==='search'){try{setSearchState(parseSearchState(params));}catch{setSearchState({...DEFAULT_SEARCH_STATE});}}if(next==='weekly'){const parsed=weekStartSchema.safeParse(params.get('week'));setWeeklyWeek(parsed.success?parsed.data:undefined);}}}
    };const click=(event:MouseEvent)=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||!(event.target instanceof Element))return;const anchor=event.target.closest('a');if(!anchor||anchor.target&&anchor.target!=='_self'||anchor.hasAttribute('download'))return;const url=new URL(anchor.href,window.location.origin);if(url.origin!==window.location.origin||url.pathname!=='/'||url.hash||!url.searchParams.has('review')&&!url.searchParams.has('subject'))return;event.preventDefault();window.history.pushState({},'',url.pathname+url.search);apply(true);};const pop=()=>apply();queueMicrotask(apply);window.addEventListener('popstate',pop);document.addEventListener('click',click,true);return()=>{active=false;window.removeEventListener('popstate',pop);document.removeEventListener('click',click,true);};
  },[envelope,expired]);
  const pinTask = (task: Task) => run({ type: 'task.update', id: task.id, patch: { weekly: !isCurrentWeek(task) } });
  const workspace = expired ? undefined : envelope?.workspace;
  const project = workspace?.projects.find(p => p.id === projectId);
  const milestone=workspace?.milestones.find(row=>row.id===milestoneId);
  const inboxCount = workspace?.captures.filter(c => c.status === 'inbox').length ?? 0;
  const name = expired ? 'Signed out' : userName?.trim() || 'Your workspace';
  return <SessionExpiredContext.Provider value={expired}><DeviceDraftProvider expired={expired} controllerRef={deviceDraftController}><div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to workspace</a>
    <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('today'); }} aria-label="Control Room home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span><strong>Control Room</strong><small>Your project workspace</small></span></a><div className="workspace-caption">WORKSPACE</div><nav className="main-nav" aria-label="Main navigation">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''} ${id === 'inbox' ? 'nav-secondary-start' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{id === 'inbox' && inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}</button>)}</nav><button className="sidebar-capture" onClick={() => openEditor({ type: 'capture' })} disabled={!workspace}><Plus size={17} />Quick capture</button><div className="sidebar-bottom"><div className="private-label"><span />Private workspace</div>{accountOpen && <a className="signout-link" onClick={event=>{event.preventDefault();void signOut();}} href="/signout-with-chatgpt?return_to=%2F"><LogOut size={15} />Sign out</a>}<button className="account-button" onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen} aria-label="Account menu"><span className="avatar">{name.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{name}</strong><small>Personal workspace</small></span><ChevronDown size={15} /></button></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">Workspace<span>/</span><strong>{navItems.find(item => item.id === view)?.label}{project ? ` / ${project.name}` : ''}</strong></div><div className="sync-indicator" role="status">{expired || stale ? <AlertCircle size={13} /> : busy || loading ? <LoaderCircle className="spinning" size={13} /> : envelope ? <Check size={13} /> : <Radio size={13} />}<span>{expired ? 'Session expired' : busy ? 'Saving…' : loading ? 'Loading…' : stale ? 'Refresh failed' : envelope ? 'Saved workspace' : 'Not loaded'}</span></div></header><main id="main-content" tabIndex={-1}>
      {(error || pendingDirectCommand) && !expired && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{error || 'The last quick action could not be confirmed. You can safely retry the original change.'}</span>{pendingDirectCommand && <button className="text-button" onClick={() => run(pendingDirectCommand)} disabled={busy || loading}>Retry change</button>}<button className="text-button" onClick={() => void refresh()} disabled={busy || loading}><RefreshCw size={14} />Refresh workspace</button><button className="icon-button" aria-label="Dismiss error and retry offer" onClick={() => { setError(''); setPendingDirectCommand(null); }}><X size={16} /></button></div>}
      {unresolved.map(item=><div className="error-banner" key={item.submission.mutationId} role="status"><span>Unconfirmed original change: {item.command.type}. It may still complete.</span><button className="text-button" disabled={busy} onClick={()=>void checkOriginal(item)}>Check original save</button></div>)}
      {workspace && <p className="refresh-metadata" role="status">Last saved {new Date(envelope!.updatedAt).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false })} Cairo · Last successful refresh {lastRefreshed ? new Date(lastRefreshed).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false }) + ' Cairo' : 'not yet confirmed'}{stale ? ' · This view may be out of date.' : ''}</p>}
      {expired ? <div className="loading-screen" role="alert"><AlertCircle size={30} /><h1>Your session has expired.</h1><p>Sign in again to open your private workspace. Private content has been closed. Server drafts remain recoverable after sign-in. Active device drafts are cleared on expiry; copies locked since an earlier visit may require signing in to the same account and choosing Forget device drafts.</p><a className="button primary" href="/signin-with-chatgpt?return_to=%2F">Sign in again<ArrowRight size={16} /></a></div> : !workspace ? <div className="loading-screen">{loading ? <><LoaderCircle size={30} className="spinning" /><h1>A little clarity is on its way.</h1><p>Loading your private workspace…</p></> : <><AlertCircle size={30} /><h1>Your workspace is waiting.</h1><p>We couldn’t load it. Your saved work has not been changed.</p><button className="button primary" onClick={() => void refresh()}>Try again<ArrowRight size={16} /></button></>}</div> : <>
        {view === 'today' && <TodayView workspace={workspace} onProject={openProject} onTask={openTask} onPin={pinTask} onProjects={() => navigate('projects')} onAttention={()=>navigate('attention')} onCapture={() => openEditor({ type: 'capture' })} busy={busy} />}
        {unavailableTarget && <div className="panel" role="status"><h2>This item is unavailable.</h2><p>It may be missing or unavailable in this workspace.</p><button className="button secondary" onClick={()=>navigate('today')}>Go home</button></div>}
        {!unavailableTarget && reviewTarget && <ReviewCitation key={reviewHref(reviewTarget)} target={reviewTarget} revision={envelope!.revision}/>}
        {!unavailableTarget && !reviewTarget && view==='history' && <HistoryView revision={envelope!.revision} onCommand={(command,revision)=>mutate(command as Command,undefined,revision)} />}
        {!unavailableTarget && !reviewTarget && view==='evidence' && <EvidenceWorkspace subject={evidenceSubject} onClearSubject={()=>{setEvidenceSubject(undefined);writeLocation('/?view=evidence');}} workspace={workspace} revision={envelope!.revision} onEvidence={(evidence,revision,snapshot)=>{if(!evidence&&evidenceSubject){setEvidenceSubject(undefined);writeLocation('/?view=evidence');}openEditor({type:'evidence',evidence,snapshot},revision);}} onAttachmentReserve={snapshot=>openEditor({type:'attachment-reserve',snapshot},snapshot.revision)} onAttachmentUpload={(attachment,snapshot)=>openEditor({type:'attachment-upload',attachment,snapshot},snapshot.revision)} onAttachmentLifecycle={(attachment,snapshot,action)=>openEditor({type:'attachment-lifecycle',attachment,snapshot,action},snapshot.revision)} onDecision={(decision,revision,snapshot)=>{if(!decision&&evidenceSubject){setEvidenceSubject(undefined);writeLocation('/?view=evidence');}openEditor({type:'decision',decision,snapshot},revision);}} onLink={(evidence,snapshot)=>openEditor({type:'evidence-link',evidence,snapshot,subject:evidenceSubject},snapshot.revision)} onRequirement={(requirement,snapshot)=>openEditor({type:'requirement',requirement,snapshot,subject:evidenceSubject},snapshot.revision)} onAssessment={(snapshot,subject)=>openEditor({type:'acceptance',snapshot,subject:subject??evidenceSubject},snapshot.revision)} onDecisionAction={(decision,snapshot,action)=>openEditor({type:'decision-action',decision,snapshot,action},snapshot.revision)} onCommand={(command,revision)=>mutate(command as Command,undefined,revision)} />}
        {!unavailableTarget && view==='weekly' && <WeeklyPlanningView key={weeklyWeek??'current'} initialWeek={weeklyWeek} onReview={(draft,revision)=>openEditor({type:'weekly-review',draft},revision)} workspace={workspace} revision={envelope!.revision} onCommand={(command,revision)=>mutate(command,undefined,revision)} onTask={openTask} onRecurrenceEdit={rule=>openEditor({type:'recurrence',rule})} />}
        {!unavailableTarget && view === 'search' && <SearchView revision={envelope!.revision} value={searchState} onStateChange={(state,mode)=>{setSearchState(state);const url=encodeSearchState(state);if(mode==='replace'){window.history.replaceState({},'',url);locationKey.current=window.location.search;}else writeLocation(url);}} workspace={workspace} onOpen={openEntity} />}
        {!unavailableTarget && view === 'attention' && <><AttentionView revision={envelope!.revision} workspace={workspace} onOpen={openEntity} /><ReviewAttentionResults revision={envelope!.revision} workspace={workspace}/></>}
        {!unavailableTarget && view === 'projects' && (milestone ? <MilestoneWorkspace workspace={workspace} milestone={milestone} onTask={openTask} onEdit={row=>openEditor({type:'milestone',milestone:row,project:workspace.projects.find(project=>project.id===row.projectId)!})} onNewTask={row=>openEditor({type:'task',projectId:row.projectId,milestoneId:row.id})} onCapture={row=>openEditor({type:'capture',capture:row})} onCommand={command=>mutate(command)} onBack={()=>project?openProject(project):navigate('projects')} /> : project ? <ProjectDetail baselineRemovedIds={envelope?.baselineRemovedIds} key={`project-detail:${project.id}`} project={project} workspace={workspace} busy={busy} onBack={() => navigate('projects')} onProjectEdit={() => openEditor({ type: 'project', project })} onProjectLifecycle={(row,action)=>run({type:action==='archive'?'project.archive':'project.restore',id:row.id})} onMilestone={openMilestone} onNewMilestone={() => openEditor({ type: 'milestone', project })} onTask={openTask} onNewTask={() => openEditor({ type: 'task', projectId: project.id })} onPin={pinTask} onApplyBaseline={(project, baselineId) => run({ type: 'baseline.apply', projectId: project.id, baselineId })} /> : <ProjectsView workspace={workspace} onProject={openProject} onCreate={()=>openEditor({type:'project'})} />)}
        {!unavailableTarget && view==='projects' && !milestone && <TaskBulkActions key={`task-bulk:${project?.id??'portfolio'}`} workspace={workspace} revision={envelope!.revision} projectId={project?.id} onTask={openTask} onCommand={(command,revision)=>mutate(command,undefined,revision)} />}
        {view === 'inbox' && <InboxView revision={envelope!.revision} onBulkCommand={(command,revision)=>mutate(command,undefined,revision)} workspace={workspace} busy={busy} onCreate={() => openEditor({ type: 'capture' })} onEdit={capture => openEditor({ type: 'capture', capture })} onConvert={capture => openEditor({ type: 'convert', capture })} onTask={openTask} onCommand={run} />}
        {view === 'sources' && envelope && <SourcesView envelope={envelope} busy={busy || loading} onRefresh={() => void refresh()} onRestore={restoreWorkspace} onPreviousBackup={loadPreviousBackup} onBackup={()=>mutate({type:'workspace.backup'})} onImport={command=>mutate(command)} onDelete={command=>mutate(command)} onBackupRemove={command=>mutate(command)} />}
      </>}
    </main><footer className="app-footer"><span>CONTROL ROOM</span><span>A little clarity. A steady next step.</span></footer></div>
    {notice && <div className="save-toast" role="status"><Check size={16} />{notice}</div>}
    <OriginalSaveContext.Provider value={{check:unresolved.find(item=>item.submission.mutationId===editorSubmissionId)?()=>checkOriginal(unresolved.find(item=>item.submission.mutationId===editorSubmissionId)!):undefined}}>
    <DurableDraftProvider baseRevision={editorRevision} controllerRef={editorDraftController} onRecover={recoverSubmission}>
    {envelope && editor?.type === 'task' && <TaskEditor key={`task:${editor.task?.id??`new:${editor.projectId}:${editor.milestoneId??''}`}`} task={editor.task} projectId={editor.projectId} initialMilestoneId={editor.milestoneId} workspace={envelope!.workspace} onSave={saveEditor} onClose={closeEditor} />}
    {envelope && editor?.type === 'milestone' && <MilestoneEditor key={`milestone:${editor.milestone?.id??`new:${editor.project.id}`}`} milestone={editor.milestone} project={editor.project} onSave={saveEditor} onClose={closeEditor} />}
    {envelope && editor?.type === 'project' && <PortfolioProjectEditor key={`project:${editor.project?.id??'new'}`} project={editor.project} onSave={saveEditor} onClose={closeEditor} />}
    {envelope && editor?.type === 'capture' && <CaptureEditor key={`capture:${editor.capture?.id??'new'}`} capture={editor.capture} workspace={envelope!.workspace} onSave={saveEditor} onClose={closeEditor} />}
    {envelope && editor?.type==='recurrence' && <RecurrenceEditor key={`recurrence:${editor.rule?.value.id??'new'}`} rule={editor.rule} workspace={envelope.workspace} onSave={saveEditor} onClose={closeEditor} />}
    {envelope && editor?.type === 'convert' && <ConvertEditor key={`convert:${editor.capture.id}`} capture={editor.capture} workspace={envelope!.workspace} onSave={saveEditor} onClose={closeEditor} />}
    {envelope && editor?.type==='weekly-review' && <WeeklyReviewEditor key={`weekly-review:${editor.draft.weekStart}:${editor.draft.supersedesId??'new'}`} draft={editor.draft} onSave={saveEditor} onClose={closeEditor} />}
    {envelope && editor?.type==='evidence' && <EvidenceEditor key={`evidence:${editor.evidence?.id??'new'}`} evidence={editor.evidence} attachments={editor.snapshot?.attachments} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='decision' && <DecisionEditor key={`decision:${editor.decision?.id??'new'}`} decision={editor.decision} workspace={envelope.workspace} snapshot={editor.snapshot} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='evidence-link' && <EvidenceLinkEditor key={`evidence-link:${editor.evidence.id}:${editor.evidence.version}`} initialSubject={editor.subject} evidence={editor.evidence} workspace={envelope.workspace} requirements={editor.snapshot.requirements} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='requirement' && <RequirementEditor key={`requirement:${editor.requirement?.value.id??'new'}`} initialSubject={editor.subject} requirement={editor.requirement} workspace={envelope.workspace} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='acceptance' && <AcceptanceDialog key={`acceptance:${editor.subject?.type??'new'}:${editor.subject?.id??''}`} workspace={envelope.workspace} snapshot={editor.snapshot} subject={editor.subject} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='decision-action' && <DecisionActionDialog key={`decision-action:${editor.action}:${editor.decision.id}`} decision={editor.decision} snapshot={editor.snapshot} action={editor.action} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='attachment-reserve' && <AttachmentReserveEditor key="attachment-reserve:new" onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='attachment-upload' && <AttachmentUploadDialog key={`attachment-upload:${editor.attachment.id}`} attachment={editor.attachment} onClose={closeEditor} onStaged={()=>setNotice('Original bytes staged. Finalization is a separate owner action.')} />}
    {envelope && editor?.type==='attachment-lifecycle' && <AttachmentLifecycleDialog key={`attachment-lifecycle:${editor.action}:${editor.attachment.id}`} attachment={editor.attachment} action={editor.action} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    </DurableDraftProvider></OriginalSaveContext.Provider>
  </div></DeviceDraftProvider></SessionExpiredContext.Provider>;
}
