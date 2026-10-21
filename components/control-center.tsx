'use client';
import type {AttachmentSnapshot,EvidenceSnapshot} from '@/lib/evidence-store';
import {parseHistorySubjectLink} from '@/lib/history-subject-links';
import type {EvidenceVersion,DecisionVersion,EvidenceRequirement,EvidenceSubject} from '@/lib/evidence-contract';
import {DEFAULT_SEARCH_STATE,encodeSearchState,parseSearchState,type SearchState} from '@/lib/planning-search-state';
import {weekStartSchema} from '@/lib/weekly-planning';
import {OriginalSaveContext,EditorOpenerContext} from './form-dialog';
import {TaskBulkActions} from './task-bulk-actions';

import { Component, createContext, createElement, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type {WeeklyReviewDraft} from './weekly-review-editor';
import { AlertCircle, ArrowRight, Check, ChevronDown, FolderOpen, Inbox, LayoutGrid, LoaderCircle, LogOut, Plus, Radio, RefreshCw, Search, ListChecks, CalendarDays, Sun, X } from 'lucide-react';
import type { Capture, Command, Milestone, Project, Task, Workspace, WorkspaceEnvelope } from '@/lib/types';
import { isCurrentWeek } from '@/lib/calendar';
import { readWorkspaceResponse, SessionExpiredError, WorkspaceRequestError, isConclusiveWorkspaceRejection, submissionFor, type Submission } from '@/lib/workspace-client';
import { boundedRequest, issueSubmissionId, sendCommand, reconcileSubmission, SaveSessionGeneration, StaleSessionError } from '@/lib/save-controller';
import { DurableDraftProvider, type DurableDraftController, type RecoveredSubmission } from './durable-draft';
import type { RecurrenceRule } from '@/lib/recurrence';
import { WorkspacePolling } from '@/lib/workspace-polling';
import {WorkspaceStreamClient,type WorkspaceStreamStatus} from '@/lib/workspace-stream-client';
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
import {parseEvidenceSubjectLink,resolveEvidenceSubject} from '@/lib/evidence-subject-links';
import { MilestoneEditor } from './planning-editors';
import { CaptureEditor, ConvertEditor } from './capture-editors';
import { TodayView } from './today-view';
import { ProjectDetail, ProjectsView } from './projects-view';
import { InboxView } from './inbox-view';
import {z} from 'zod';
import {canonical,contentHash} from '@/lib/canonical-json';
import type {GenericDeviceEnrollmentInput} from '@/lib/devices/validation';
import type {JobBudgetDisplay} from '@/lib/agents/read-model';
import {RuntimeView,EnrollmentSecretUnavailableError,EnrollmentNotStartedError,type RuntimeEnrollmentResult} from './runtime-view';
import type {ReviewSnapshot} from '@/lib/reviews/contracts';

// Load noninitial panels only when selected; no private data or fetch is cached.
class PanelModuleLoadError extends Error{constructor(){super('The selected panel module could not be loaded.');this.name='PanelModuleLoadError';}}
async function boundedPanelModule<T>(load:()=>Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([load(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Panel module load deadline exceeded.')),15000);})]);}
 catch{throw new PanelModuleLoadError();}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
// Module definitions only: no owner data, requests or authorization is retained.
const panelModuleFactories=new Map<symbol,()=>unknown>();
const PanelRetryContext=createContext<ReadonlyMap<symbol,unknown>|null>(null);
function deferredPanel<P extends object>(load:()=>Promise<{default:ComponentType<P>}>):ComponentType<P>{
 const id=Symbol(),create=()=>lazy(()=>boundedPanelModule(load)),Initial=create();
 panelModuleFactories.set(id,create);
 return function DeferredComponent(props:P){
  const resources=useContext(PanelRetryContext),Selected=(resources?.get(id)??Initial) as ComponentType<P>;
  return createElement(Selected,props);
 };
}
const AttachmentReserveEditor=deferredPanel<Parameters<typeof import('./attachment-dialogs').AttachmentReserveEditor>[0]>(()=>import('./attachment-dialogs').then(module=>({default:module.AttachmentReserveEditor})));
const AttachmentUploadDialog=deferredPanel<Parameters<typeof import('./attachment-dialogs').AttachmentUploadDialog>[0]>(()=>import('./attachment-dialogs').then(module=>({default:module.AttachmentUploadDialog})));
const AttachmentLifecycleDialog=deferredPanel<Parameters<typeof import('./attachment-dialogs').AttachmentLifecycleDialog>[0]>(()=>import('./attachment-dialogs').then(module=>({default:module.AttachmentLifecycleDialog})));
const EvidenceLinkEditor=deferredPanel<Parameters<typeof import('./evidence-link-editor').EvidenceLinkEditor>[0]>(()=>import('./evidence-link-editor').then(module=>({default:module.EvidenceLinkEditor})));
const RequirementEditor=deferredPanel<Parameters<typeof import('./requirement-editor').RequirementEditor>[0]>(()=>import('./requirement-editor').then(module=>({default:module.RequirementEditor})));
const AcceptanceDialog=deferredPanel<Parameters<typeof import('./acceptance-dialog').AcceptanceDialog>[0]>(()=>import('./acceptance-dialog').then(module=>({default:module.AcceptanceDialog})));
const DecisionActionDialog=deferredPanel<Parameters<typeof import('./decision-action-dialog').DecisionActionDialog>[0]>(()=>import('./decision-action-dialog').then(module=>({default:module.DecisionActionDialog})));
const HistoryView=deferredPanel<Parameters<typeof import('./history-view').HistoryView>[0]>(()=>import('./history-view').then(module=>({default:module.HistoryView})));
const EvidenceWorkspace=deferredPanel<Parameters<typeof import('./evidence-workspace').EvidenceWorkspace>[0]>(()=>import('./evidence-workspace').then(module=>({default:module.EvidenceWorkspace})));
const EvidenceEditor=deferredPanel<Parameters<typeof import('./evidence-editor').EvidenceEditor>[0]>(()=>import('./evidence-editor').then(module=>({default:module.EvidenceEditor})));
const DecisionEditor=deferredPanel<Parameters<typeof import('./decision-editor').DecisionEditor>[0]>(()=>import('./decision-editor').then(module=>({default:module.DecisionEditor})));
const WeeklyReviewEditor=deferredPanel<Parameters<typeof import('./weekly-review-editor').WeeklyReviewEditor>[0]>(()=>import('./weekly-review-editor').then(module=>({default:module.WeeklyReviewEditor})));
const WeeklyPlanningView=deferredPanel<Parameters<typeof import('./weekly-planning-view').WeeklyPlanningView>[0]>(()=>import('./weekly-planning-view').then(module=>({default:module.WeeklyPlanningView})));
const RecurrenceEditor=deferredPanel<Parameters<typeof import('./recurrence-editor').RecurrenceEditor>[0]>(()=>import('./recurrence-editor').then(module=>({default:module.RecurrenceEditor})));
const ReviewCitation=deferredPanel<Parameters<typeof import('./review-citation').ReviewCitation>[0]>(()=>import('./review-citation').then(module=>({default:module.ReviewCitation})));
const ExecutionEnrollmentDialog=deferredPanel<Parameters<typeof import('./execution-enrollment-dialog').ExecutionEnrollmentDialog>[0]>(()=>import('./execution-enrollment-dialog').then(module=>({default:module.ExecutionEnrollmentDialog})));
const JobBudgetEditor=deferredPanel<Parameters<typeof import('./job-budget-editor').JobBudgetEditor>[0]>(()=>import('./job-budget-editor').then(module=>({default:module.JobBudgetEditor})));
const JobEditor=deferredPanel<Parameters<typeof import('./job-editor').JobEditor>[0]>(()=>import('./job-editor').then(module=>({default:module.JobEditor})));
const BaselineRevisionEditor=deferredPanel<Parameters<typeof import('./baseline-revision-editor').BaselineRevisionEditor>[0]>(()=>import('./baseline-revision-editor').then(module=>({default:module.BaselineRevisionEditor})));
const LocalRepositoryOnboarding=deferredPanel<Parameters<typeof import('./repository-onboarding').RepositoryOnboarding>[0]>(()=>import('./repository-onboarding').then(module=>({default:module.RepositoryOnboarding})));
const SourcesView=deferredPanel<Parameters<typeof import('./sources-view').SourcesView>[0]>(()=>import('./sources-view').then(module=>({default:module.SourcesView})));
const ReviewCenter=deferredPanel<Parameters<typeof import('./review-center').ReviewCenter>[0]>(()=>import('./review-center').then(module=>({default:module.ReviewCenter})));
const AgentsView=deferredPanel<Parameters<typeof import('./agents-view').AgentsView>[0]>(()=>import('./agents-view').then(module=>({default:module.AgentsView})));
function ViewLoading({label}:{label:string}){return <p role="status" className="muted">Loading {label}…</p>;}
class PanelLoadBoundary extends Component<{label:string;children:ReactNode;onRetry:()=>void;onBack:()=>void},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(error:unknown){if(!(error instanceof PanelModuleLoadError))throw error;return {failed:true};}
 render(){return this.state.failed?<section className="panel" role="alert"><h2>{this.props.label} could not be loaded.</h2><p>The selected panel did not finish loading. Retry loading it or return to Today. Review any pending save outcome before retrying a change; saved draft recovery remains available.</p><div className="data-actions"><button type="button" className="button secondary" onClick={this.props.onRetry}>Retry loading panel</button><button type="button" className="button secondary" onClick={this.props.onBack}>Return to Today</button></div></section>:this.props.children;}
}
function DeferredPanel({label,children,canRetry,onBack}:{label:string;children:ReactNode;canRetry:()=>boolean;onBack:()=>void}){
 const [retry,setRetry]=useState<{attempt:number;resources:ReadonlyMap<symbol,unknown>|null}>({attempt:0,resources:null});
 const retryModule=()=>{if(!canRetry())return;const resources=new Map<symbol,unknown>();for(const [id,create]of panelModuleFactories)resources.set(id,create());setRetry(value=>({attempt:value.attempt+1,resources}));};
 return <PanelRetryContext.Provider value={retry.resources}><PanelLoadBoundary key={retry.attempt} label={label} onRetry={retryModule} onBack={onBack}><Suspense fallback={<ViewLoading label={label}/>}>{children}</Suspense></PanelLoadBoundary></PanelRetryContext.Provider>;
}

type View = 'today' | 'projects' | 'inbox' | 'sources' | 'reviews' | 'search' | 'attention' | 'weekly' | 'evidence' | 'history' | 'runtime' | 'agents' | 'local-analysis';
type SaveBase = { revision: number; submission?: Submission | null };
type Editor = {type:'agent-budget';budget?:JobBudgetDisplay}|{type:'execution-enrollment'}|{type:'agent-job';projectId?:string;taskId?:string}|{type:'baseline-revision';projectId:string;snapshot:ReviewSnapshot;snapshotHash:string}|{type:'attachment-reserve';snapshot:EvidenceSnapshot}|{type:'attachment-upload';attachment:AttachmentSnapshot;snapshot:EvidenceSnapshot}|{type:'attachment-lifecycle';attachment:AttachmentSnapshot;snapshot:EvidenceSnapshot;action:'finalize'|'retire'}|{type:'evidence';evidence?:EvidenceVersion;snapshot?:EvidenceSnapshot}|{type:'decision';decision?:DecisionVersion;snapshot?:EvidenceSnapshot}|{type:'evidence-link';evidence:EvidenceVersion;snapshot:EvidenceSnapshot;subject?:EvidenceSubject}|{type:'requirement';requirement?:{value:EvidenceRequirement;rowRevision:number};snapshot:EvidenceSnapshot;subject?:EvidenceSubject}|{type:'acceptance';snapshot:EvidenceSnapshot;subject?:EvidenceSubject}|{type:'decision-action';decision:DecisionVersion;snapshot:EvidenceSnapshot;action:'decide'|'supersede'}|{ type: 'task'; task?: Task; projectId: string; milestoneId?:string; suggestion?:{title:string;notes:string;draftKey:string} } | { type: 'milestone'; milestone?: Milestone; project: Project } | { type: 'project'; project?: Project } | { type: 'capture'; capture?: Capture } | { type: 'convert'; capture: Capture } | {type:'recurrence';rule?:{value:RecurrenceRule;rowRevision:number}} | {type:'weekly-review';draft:WeeklyReviewDraft};
const navItems = [{id:'local-analysis',label:'Repositories',icon:FolderOpen}, { id: 'today', label: 'Today', icon: Sun }, { id: 'projects', label: 'Projects', icon: LayoutGrid }, { id: 'inbox', label: 'Inbox', icon: Inbox }, {id:'weekly',label:'Weekly',icon:CalendarDays}, { id: 'search', label: 'Search', icon: Search }, { id: 'attention', label: 'Attention', icon: ListChecks }, { id: 'history', label: 'History', icon: FolderOpen }, { id: 'evidence', label: 'Evidence & decisions', icon: ListChecks }, { id: 'sources', label: 'Sources', icon: FolderOpen },{id:'reviews',label:'Briefs & automations',icon:Radio},{id:'runtime',label:'Runtime',icon:Radio},{id:'agents',label:'Agents',icon:Radio}] as const;

export default function ControlCenter({ userName }: { userName: string }) {
  const [envelope, setEnvelope] = useState<WorkspaceEnvelope | null>(null);
  const envelopeRef = useRef<WorkspaceEnvelope | null>(null);
  const sessionGeneration = useRef(new SaveSessionGeneration());
  const polling=useRef<WorkspacePolling<WorkspaceEnvelope>|null>(null);
  const stream=useRef<WorkspaceStreamClient|null>(null);
  const [streamStatus,setStreamStatus]=useState<WorkspaceStreamStatus>('polling-unverified');
  const readFlight=useRef<Promise<WorkspaceEnvelope>|null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const sourcePendingRef=useRef(false);
  const sourceDirtyRef=useRef(false);
  const agentPanelGuards=useRef({jobsDirty:false,jobsPending:false,enrollmentDirty:false,enrollmentPending:false});
  const agentGuard=(key:'jobsDirty'|'jobsPending'|'enrollmentDirty'|'enrollmentPending',value:boolean)=>{agentPanelGuards.current[key]=value;sourceDirtyRef.current=agentPanelGuards.current.jobsDirty||agentPanelGuards.current.enrollmentDirty;sourcePendingRef.current=agentPanelGuards.current.jobsPending||agentPanelGuards.current.enrollmentPending;polling.current?.setBusy(sourcePendingRef.current||busyRef.current);stream.current?.setBusy((sourcePendingRef.current||busyRef.current)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));};
  useEffect(()=>{const leave=(event:BeforeUnloadEvent)=>{if(sourceDirtyRef.current||sourcePendingRef.current)event.preventDefault();};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expired, setExpired] = useState(false);
  const expiredRef = useRef(false);
  const [stale, setStale] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [editorOpener,setEditorOpener]=useState<HTMLElement|null>(null);
  const editorDraftController=useRef<DurableDraftController|null>(null);
  const deviceDraftController=useRef<DeviceDraftController|null>(null);
  const [unresolved,setUnresolved]=useState<{submission:Submission;command:Command}[]>([]);
  const runtimeEnrollment=useRef<{key:string;body:string;mutationId:string;commandHash:string;revision:number;generation:number}|null>(null);
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
  const expireSession = useCallback(() => { polling.current?.setSignedIn(false);stream.current?.setSignedIn(false);sessionGeneration.current.invalidate(); expiredRef.current = true; envelopeRef.current = null; editorBaseRef.current = null; directSubmission.current = null; runtimeEnrollment.current=null; setEnvelope(null); setEditor(null); setPendingDirectCommand(null); setUnresolved([]); setExpired(true); setNotice(''); setError(''); }, []);
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
    let active=true;const notices=new WorkspaceStreamClient({enabled:false,onNotice:()=>{if(expiredRef.current||busyRef.current||sourcePendingRef.current||sourceDirtyRef.current||editorDraftController.current?.isDirty())return;void coordinator.manual();},onExpire:expireSession,onStatus:status=>{if(active)setStreamStatus(status);}});stream.current=notices;notices.setSignedIn(!expiredRef.current);notices.setVisible(document.visibilityState!=='hidden');notices.setBusy(busyRef.current||sourcePendingRef.current||sourceDirtyRef.current);notices.start();
    const focus=()=>coordinator.focus(),online=()=>coordinator.online(),visibility=()=>{const visible=document.visibilityState!=='hidden';coordinator.setVisible(visible);notices.setVisible(visible);};window.addEventListener('focus',focus);window.addEventListener('online',online);document.addEventListener('visibilitychange',visibility);coordinator.start();
    return()=>{active=false;notices.dispose();if(stream.current===notices)stream.current=null;coordinator.dispose();if(polling.current===coordinator)polling.current=null;window.removeEventListener('focus',focus);window.removeEventListener('online',online);document.removeEventListener('visibilitychange',visibility);};
  },[requestCurrent,acceptEnvelope,expireSession]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4500); return () => window.clearTimeout(timer); }, [notice]);
  async function mutate(command: Command, editorBase?: SaveBase, expectedRevision?:number) {
    if (expiredRef.current) throw new SessionExpiredError();
    if (!envelopeRef.current) throw new Error('Load your workspace before saving.');
    if (busyRef.current) throw new Error('Another change is saving. Please try again in a moment.');
    busyRef.current = true;polling.current?.setBusy(true);stream.current?.setBusy((true)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));setBusy(true); setError('');
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
        next=await sendCommand({revision:editorBase?.revision ?? expectedRevision ?? envelopeRef.current.revision,mutationId:submission.mutationId,command},{session:sessionGeneration.current,generation,...(['local-analysis.save','github-analysis.save'].includes(command.type)?{deadlineMs:60_000}:{})});
      } catch(cause) {
        if(cause instanceof SessionExpiredError){expireSession();throw cause;}
        if(cause instanceof StaleSessionError)throw cause;
        if(cause instanceof WorkspaceRequestError && cause.status===409 && isConclusiveWorkspaceRejection(cause)){
          if(cause.diagnostic==='revision_conflict'||cause.diagnostic==='module_conflict'){if(editorBase){await editorDraftController.current?.releaseSubmission();editorBase.submission=null;}else directSubmission.current=null;}
          const latest=await read(true);
          if(editorBase)editorBase.revision=latest.revision;
          cause.message='This workspace changed in another session. The latest version is loaded and your draft is still here. Review your changes, then save again.';throw cause;
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
    } finally { busyRef.current = false;polling.current?.setBusy(false);stream.current?.setBusy((false)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));setBusy(false); }
  }
  async function saveLocalAnalysis(command:import('@/lib/workspace-protocol').WorkspaceCommand):Promise<boolean>{
    try{await mutate(command as Command);return true;}catch(cause){setError(cause instanceof Error?cause.message:'The report save is unconfirmed.');if(['github-analysis.save','local-analysis.save'].includes(command.type)&&isConclusiveWorkspaceRejection(cause)){const key=submissionFor(null,command).key;setUnresolved(items=>items.filter(item=>item.submission.key!==key));throw cause;}return false;}
  }
  function retainedLocalAnalysisSave(runId:string):import('@/lib/workspace-protocol').WorkspaceCommand|undefined{const retained=unresolved.find(item=>{const command=item.command as unknown as {type:string;report?:{run?:{id?:unknown}}};return command.type==='local-analysis.save'&&command.report?.run?.id===runId;});return retained?.command as unknown as import('@/lib/workspace-protocol').WorkspaceCommand|undefined;}
  async function createLocalAnalysisProject(name:string):Promise<string|null>{
    const original=new Set(envelopeRef.current?.workspace.projects.map(project=>project.id));
    try{await mutate({type:'project.create',project:{name,description:'',goal:'',color:'teal',repositories:[]}} as Command);return envelopeRef.current?.workspace.projects.find(project=>!original.has(project.id))?.id??null;}catch(cause){setError(cause instanceof Error?cause.message:'The project save is unconfirmed.');return null;}
  }
  async function enrollRuntimeDevice(input:GenericDeviceEnrollmentInput):Promise<RuntimeEnrollmentResult>{
    if(expiredRef.current)throw new SessionExpiredError();
    if(!envelopeRef.current)throw new EnrollmentNotStartedError('Load the saved workspace before enrollment.');
    if(busyRef.current)throw new EnrollmentNotStartedError('Wait for the current owner change before enrollment.');
    if(directSubmission.current||editorBaseRef.current?.submission)throw new EnrollmentNotStartedError('Resolve the original owner change before enrollment.');
    const command={type:'devices.enrollment.create',value:{label:input.label,...(input.deviceId?{deviceId:input.deviceId}:{}),scopes:[...input.scopes]}};
    const key=canonical(command);
    if(runtimeEnrollment.current&&runtimeEnrollment.current.key!==key)throw new Error('Retry the original enrollment request before starting another.');
    busyRef.current=true;polling.current?.setBusy(true);stream.current?.setBusy((true)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));setBusy(true);
    let retained=runtimeEnrollment.current;
    const receiptSchema=z.object({mutationId:z.string().regex(/^m1_[a-f0-9]{32}_[a-f0-9]{32}$/),commandHash:z.string().regex(/^[a-f0-9]{64}$/),appliedRevision:z.number().int().positive().safe()}).strict();
    const resultSchema=z.object({deviceId:z.string().min(1).max(128),enrollmentId:z.string().min(1).max(128),secret:z.string().min(16).max(4096),expiresAt:z.string().datetime({offset:true})}).strict();
    const successSchema=z.object({result:resultSchema,receipt:receiptSchema,envelope:z.unknown()}).strict();
    const unavailableSchema=z.object({code:z.literal('enrollment-secret-unavailable'),receipt:receiptSchema,envelope:z.unknown()}).strict();
    try{
      if(!retained){
        const generation=sessionGeneration.current.capture();
        let mutationId:string;
        try{mutationId=await issueSubmissionId({session:sessionGeneration.current,generation});}
        catch(cause){if(cause instanceof SessionExpiredError||cause instanceof StaleSessionError)throw cause;throw new EnrollmentNotStartedError();}
        sessionGeneration.current.assertCurrent(generation);
        if(expiredRef.current)throw new SessionExpiredError();
        const revision=envelopeRef.current!.revision,commandHash=await contentHash(canonical({protocolVersion:1,command}));
        sessionGeneration.current.assertCurrent(generation);
        retained={key,revision,mutationId,commandHash,generation,body:JSON.stringify({revision,mutationId,command})};runtimeEnrollment.current=retained;
      }
      const original=retained;
      const result=await boundedRequest('/api/devices/enroll',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:original.body},async response=>{
        if(response.status!==409&&!response.ok){await readWorkspaceResponse(response);throw new Error('Enrollment was not confirmed.');}
        const raw:unknown=await response.json();
        if(!response.ok&&!unavailableSchema.safeParse(raw).success){await readWorkspaceResponse(Response.json(raw,{status:response.status,headers:response.headers}));throw new Error('Enrollment was not confirmed.');}
        const value=response.ok?successSchema.parse(raw):unavailableSchema.parse(raw);
        if(value.receipt.mutationId!==original.mutationId||value.receipt.commandHash!==original.commandHash||value.receipt.appliedRevision!==original.revision+1)throw new Error('Enrollment receipt identity differs.');
        const next=await readWorkspaceResponse(Response.json(value.envelope));
        if(!Number.isSafeInteger(next.revision)||next.revision<value.receipt.appliedRevision)throw new Error('Enrollment workspace receipt differs.');
        return {value,next};
      },{session:sessionGeneration.current,generation:original.generation});
      if('code'in result.value){
        const outcome=await reconcileSubmission(original.mutationId,{session:sessionGeneration.current,generation:original.generation});
        if(outcome.status!=='committed'||outcome.receipt.commandHash!==original.commandHash||outcome.receipt.appliedRevision!==result.value.receipt.appliedRevision)throw new Error('Original enrollment outcome is not confirmed.');
        acceptEnvelope(result.next);runtimeEnrollment.current=null;throw new EnrollmentSecretUnavailableError(input.label);
      }
      acceptEnvelope(result.next);runtimeEnrollment.current=null;
      return result.value.result;
    }catch(cause){
      if(cause instanceof SessionExpiredError){expireSession();throw cause;}
      if(cause instanceof StaleSessionError||cause instanceof EnrollmentSecretUnavailableError||cause instanceof EnrollmentNotStartedError)throw cause;
      if(isConclusiveWorkspaceRejection(cause)){runtimeEnrollment.current=null;throw cause;}
      if(retained){
        const outcome=await reconcileSubmission(retained.mutationId,{session:sessionGeneration.current,generation:retained.generation});
        if(outcome.status==='committed'&&outcome.receipt.commandHash===retained.commandHash&&outcome.receipt.appliedRevision===retained.revision+1){
          await read(true);runtimeEnrollment.current=null;throw new EnrollmentSecretUnavailableError(input.label);
        }
      }
      throw cause;
    }finally{busyRef.current=false;polling.current?.setBusy(sourcePendingRef.current);stream.current?.setBusy((sourcePendingRef.current)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));setBusy(false);}
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
    // Preserve the real trigger before disabling it or awaiting a deferred editor module.
    setEditorOpener(document.activeElement instanceof HTMLElement?document.activeElement:null);
    // Use the displayed snapshot, even if an in-flight read has already updated the ref.
    editorBaseRef.current = { revision: sourceRevision??envelope.revision };setEditorRevision(sourceRevision??envelope.revision);
    editorReturnLocation.current=window.location.pathname+window.location.search;setEditorSubmissionId(null);setEditor(next);
  };
  const closeEditor = () => {
    const restoreLocation=editor!==null||editorReturnLocation.current!==null;
    editorBaseRef.current=null;setEditorSubmissionId(null);setEditor(null);
    if(!restoreLocation)return;
    const target=view==='search'?encodeSearchState(searchState):editorReturnLocation.current??(view==='projects'&&projectId?entityHref({kind:'project',id:projectId}):`/?view=${view}`);
    editorReturnLocation.current=null;window.history.replaceState({},'',target);locationKey.current=window.location.search;
  };
  const saveEditor = (command: Command) => {
    if (!editorBaseRef.current) return Promise.reject(new Error('Reopen this editor before saving.'));
    return mutate(command, editorBaseRef.current);
  };
  const [evidenceSubject,setEvidenceSubject]=useState<EvidenceSubject|undefined>();
  const [reviewTarget,setReviewTarget]=useState<ReviewTarget|null>(null);
  const mayNavigate=()=>{if(sourcePendingRef.current){setError('Keep this panel open until the original request outcome is confirmed. Retry the unchanged request here.');return false;}if(busyRef.current){setError('Wait for the current save outcome before leaving this editor.');return false;}if(sourceDirtyRef.current&&!window.confirm('Leave these edits? Unsaved selections and previews will be discarded.'))return false;return !editorDraftController.current?.isDirty()||window.confirm('Leave this editor? Unsaved changes may be discarded. Saved draft copies remain available.');};
  const writeLocation=(url:string)=>{window.history.pushState({},'',url);locationKey.current=window.location.search;};
  const navigate = (next: View) => { if(!mayNavigate())return;closeEditor();setReviewTarget(null);setEvidenceSubject(undefined);setView(next);setProjectId(null);setMilestoneId(null);setUnavailableTarget(false);setAccountOpen(false);writeLocation(next==='search'?encodeSearchState(searchState):`/?view=${next}`);if(next==='weekly')setWeeklyWeek(undefined);window.scrollTo({ top: 0, behavior: 'instant' }); };
  const openLocalAnalysis=(id?:string)=>{if(!mayNavigate())return;closeEditor();setReviewTarget(null);setEvidenceSubject(undefined);setView('local-analysis');setProjectId(id??null);setMilestoneId(null);setUnavailableTarget(false);writeLocation(`/?view=local-analysis${id?`&projectId=${encodeURIComponent(id)}`:''}`);window.scrollTo({top:0,behavior:'instant'});};
  const openProject = (project: Project) => {if(!mayNavigate())return;closeEditor();setReviewTarget(null);setEvidenceSubject(undefined);setView('projects');setProjectId(project.id);setMilestoneId(null);setUnavailableTarget(false);writeLocation(entityHref({kind:'project',id:project.id}));window.scrollTo({top:0,behavior:'instant'});};
  const openMilestone=(milestone:Milestone)=>{if(!mayNavigate())return;closeEditor();setReviewTarget(null);setEvidenceSubject(undefined);setView('projects');setProjectId(milestone.projectId);setMilestoneId(milestone.id);setUnavailableTarget(false);writeLocation(entityHref({kind:'milestone',id:milestone.id}));window.scrollTo({top:0,behavior:'instant'});};
  const openTask = (task: Task) => {if(!mayNavigate())return;openEditor({ type: 'task', task, projectId: task.projectId });writeLocation(entityHref({kind:'task',id:task.id}));};
  const openEntity=(target:EntityTarget)=>{const ws=envelopeRef.current?.workspace;if(!ws)return;if(target.kind==='project'){const row=ws.projects.find(row=>row.id===target.id);if(row)openProject(row);}else if(target.kind==='milestone'){const row=ws.milestones.find(row=>row.id===target.id);if(row)openMilestone(row);}else if(target.kind==='task'){const row=ws.tasks.find(row=>row.id===target.id);if(row)openTask(row);}else{const row=ws.captures.find(row=>row.id===target.id);if(row&&mayNavigate()){setView('inbox');openEditor({type:'capture',capture:row});writeLocation(entityHref(target));}}};
  useEffect(()=>{
    if(!envelope||expired)return;
    let active=true;const apply=(force=false)=>{if(!active||expiredRef.current||envelopeRef.current!==envelope)return;const key=window.location.search;if(!force&&locationKey.current===key)return;if(busyRef.current||sourcePendingRef.current){window.history.pushState({},'',`/${locationKey.current??''}`);setError('Wait for the current save outcome before leaving this editor.');return;}if(sourceDirtyRef.current&&!window.confirm('Leave these edits? Unsaved selections and previews will be discarded.')){window.history.pushState({},'',`/${locationKey.current??''}`);return;}if(editorDraftController.current?.isDirty()&&!window.confirm('Leave this editor? Unsaved changes may be discarded. Saved draft copies remain available.')){window.history.pushState({},'',`/${locationKey.current??''}`);return;}locationKey.current=key;const params=new URLSearchParams(key);setEditor(null);setEditorSubmissionId(null);editorBaseRef.current=null;editorReturnLocation.current=null;setMilestoneId(null);setProjectId(null);setReviewTarget(null);setEvidenceSubject(undefined);setUnavailableTarget(false);
      if(params.has('review')){const result=parseReviewLink(params);if(result.status==='unavailable'){setUnavailableTarget(true);return;}setReviewTarget(result.target);setView(result.target.kind==='history'?'history':'evidence');}
      else if(params.has('subject')){const historyScope=params.get('view')==='history';const parsed=historyScope?parseHistorySubjectLink(params):parseEvidenceSubjectLink(params);if(parsed.status==='unavailable'||resolveEvidenceSubject(envelope.workspace,parsed.target).status==='unavailable'){setUnavailableTarget(true);return;}setEvidenceSubject(parsed.target);setView(historyScope?'history':'evidence');}
      else if(params.has('entity')){const result=parseEntityLink(params,envelope.workspace);if(result.status==='unavailable'){setUnavailableTarget(true);return;}const target=result.target;setView(target.kind==='capture'?'inbox':'projects');if(target.kind==='project')setProjectId(target.id);else if(target.kind==='milestone'){const row=envelope.workspace.milestones.find(row=>row.id===target.id)!;setProjectId(row.projectId);setMilestoneId(row.id);}else if(target.kind==='task'){const row=envelope.workspace.tasks.find(row=>row.id===target.id)!;setProjectId(row.projectId);editorBaseRef.current={revision:envelope.revision};setEditorRevision(envelope.revision);setEditor({type:'task',task:row,projectId:row.projectId});}else{const row=envelope.workspace.captures.find(row=>row.id===target.id)!;editorBaseRef.current={revision:envelope.revision};setEditorRevision(envelope.revision);setEditor({type:'capture',capture:row});}}
      else{const next=params.get('view');if(next&&navItems.some(item=>item.id===next)){setView(next as View);if(next==='local-analysis'){const id=params.get('projectId');if(id&&envelope.workspace.projects.some(project=>project.id===id))setProjectId(id);}if(next==='search'){try{setSearchState(parseSearchState(params));}catch{setSearchState({...DEFAULT_SEARCH_STATE});}}if(next==='weekly'){const parsed=weekStartSchema.safeParse(params.get('week'));setWeeklyWeek(parsed.success?parsed.data:undefined);}}}
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
    <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('today'); }} aria-label="Control Room home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span><strong>Control Room</strong><small>Your project workspace</small></span></a><div className="workspace-caption">WORKSPACE</div><nav className="main-nav" aria-label="Main navigation">{navItems.filter(item=>['local-analysis','today','projects','inbox','weekly','search'].includes(item.id)).map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''} ${id === 'inbox' ? 'nav-secondary-start' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{id === 'inbox' && inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}</button>)}<details open={!['local-analysis','today','projects','inbox','weekly','search'].includes(view)}><summary className="nav-item">More details</summary>{navItems.filter(item=>!['local-analysis','today','projects','inbox','weekly','search'].includes(item.id)).map(({id,label,icon:Icon})=><button key={id} className={view===id?'nav-item active':'nav-item'} aria-current={view===id?'page':undefined} onClick={()=>navigate(id)}><Icon size={19} strokeWidth={1.7}/><span>{label}</span></button>)}</details></nav><button className="sidebar-capture" onClick={() => {if(mayNavigate())openEditor({ type: 'capture' });}} disabled={!workspace}><Plus size={17} />Quick capture</button><div className="sidebar-bottom"><div className="private-label"><span />Private workspace</div>{accountOpen && <a className="signout-link" onClick={event=>{event.preventDefault();void signOut();}} href="/signout-with-chatgpt?return_to=%2F"><LogOut size={15} />Sign out</a>}<button className="account-button" onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen} aria-label="Account menu"><span className="avatar">{name.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{name}</strong><small>Personal workspace</small></span><ChevronDown size={15} /></button></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">Workspace<span>/</span><strong>{navItems.find(item => item.id === view)?.label}{project ? ` / ${project.name}` : ''}</strong></div><div className="sync-indicator" role="status">{expired || stale ? <AlertCircle size={13} /> : busy || loading ? <LoaderCircle className="spinning" size={13} /> : envelope ? <Check size={13} /> : <Radio size={13} />}<span>{expired ? 'Session expired' : busy ? 'Saving…' : loading ? 'Loading…' : stale ? 'Refresh failed' : envelope ? 'Saved workspace' : 'Not loaded'}</span></div></header><main id="main-content" tabIndex={-1}>
      {(error || pendingDirectCommand) && !expired && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{error || 'The last quick action could not be confirmed. You can safely retry the original change.'}</span>{pendingDirectCommand && <button className="text-button" onClick={() => run(pendingDirectCommand)} disabled={busy || loading}>Retry change</button>}<button className="text-button" onClick={() => void refresh()} disabled={busy || loading}><RefreshCw size={14} />Refresh workspace</button><button className="icon-button" aria-label="Dismiss error and retry offer" onClick={() => { setError(''); setPendingDirectCommand(null); }}><X size={16} /></button></div>}
      {unresolved.map(item=><div className="error-banner" key={item.submission.mutationId} role="status"><span>Unconfirmed original change: {item.command.type}. It may still complete.</span><button className="text-button" disabled={busy} onClick={()=>void checkOriginal(item)}>Check original save</button></div>)}
      {workspace && <p className="refresh-metadata"><span>{streamStatus==='streaming'?'Live updates: stream notices with polling safety':streamStatus==='connecting'?'Live updates: polling while stream connects':streamStatus==='polling-fallback'?'Live updates: polling (stream unavailable)':'Live updates: polling (streaming unverified)'}</span></p>}
      {workspace && <p className="refresh-metadata" role="status">Last saved {new Date(envelope!.updatedAt).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false })} Cairo · Last successful refresh {lastRefreshed ? new Date(lastRefreshed).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false }) + ' Cairo' : 'not yet confirmed'}{stale ? ' · This view may be out of date.' : ''}</p>}
      {expired ? <div className="loading-screen" role="alert"><AlertCircle size={30} /><h1>Your session has expired.</h1><p>Sign in again to open your private workspace. Private content has been closed. Server drafts remain recoverable after sign-in. Active device drafts are cleared on expiry; copies locked since an earlier visit may require signing in to the same account and choosing Forget device drafts.</p><a className="button primary" href="/signin-with-chatgpt?return_to=%2F">Sign in again<ArrowRight size={16} /></a></div> : !workspace ? <div className="loading-screen">{loading ? <><LoaderCircle size={30} className="spinning" /><h1>A little clarity is on its way.</h1><p>Loading your private workspace…</p></> : <><AlertCircle size={30} /><h1>Your workspace is waiting.</h1><p>We couldn’t load it. Your saved work has not been changed.</p><button className="button primary" onClick={() => void refresh()}>Try again<ArrowRight size={16} /></button></>}</div> : <>
        {view === 'today' && <TodayView workspace={workspace} onProject={openProject} onTask={openTask} onPin={pinTask} onProjects={() => navigate('projects')} onAttention={()=>navigate('attention')} onOpenReviews={()=>navigate('reviews')} onCapture={() => openEditor({ type: 'capture' })} busy={busy} />}
        {unavailableTarget && <div className="panel" role="status"><h2>This item is unavailable.</h2><p>It may be missing or unavailable in this workspace.</p><button className="button secondary" onClick={()=>navigate('today')}>Go home</button></div>}
        {!unavailableTarget && reviewTarget && <DeferredPanel label="Exact review citation" canRetry={mayNavigate} onBack={()=>navigate('today')}><ReviewCitation key={reviewHref(reviewTarget)} target={reviewTarget} revision={envelope!.revision}/></DeferredPanel>}
        {!unavailableTarget && !reviewTarget && view==='history' && <DeferredPanel label="History" canRetry={mayNavigate} onBack={()=>navigate('today')}><HistoryView key={evidenceSubject?`history:${evidenceSubject.type}:${evidenceSubject.id}`:'history:all'} subject={evidenceSubject} revision={envelope!.revision} onCommand={(command,revision)=>mutate(command as Command,undefined,revision)} /></DeferredPanel>}
        {!unavailableTarget && !reviewTarget && view==='evidence' && <DeferredPanel label="Evidence and decisions" canRetry={mayNavigate} onBack={()=>navigate('today')}><EvidenceWorkspace subject={evidenceSubject} onClearSubject={()=>{setEvidenceSubject(undefined);writeLocation('/?view=evidence');}} workspace={workspace} revision={envelope!.revision} onEvidence={(evidence,revision,snapshot)=>{if(!evidence&&evidenceSubject){setEvidenceSubject(undefined);writeLocation('/?view=evidence');}openEditor({type:'evidence',evidence,snapshot},revision);}} onAttachmentReserve={snapshot=>openEditor({type:'attachment-reserve',snapshot},snapshot.revision)} onAttachmentUpload={(attachment,snapshot)=>openEditor({type:'attachment-upload',attachment,snapshot},snapshot.revision)} onAttachmentLifecycle={(attachment,snapshot,action)=>openEditor({type:'attachment-lifecycle',attachment,snapshot,action},snapshot.revision)} onDecision={(decision,revision,snapshot)=>{if(!decision&&evidenceSubject){setEvidenceSubject(undefined);writeLocation('/?view=evidence');}openEditor({type:'decision',decision,snapshot},revision);}} onLink={(evidence,snapshot)=>openEditor({type:'evidence-link',evidence,snapshot,subject:evidenceSubject},snapshot.revision)} onRequirement={(requirement,snapshot)=>openEditor({type:'requirement',requirement,snapshot,subject:evidenceSubject},snapshot.revision)} onAssessment={(snapshot,subject)=>openEditor({type:'acceptance',snapshot,subject:subject??evidenceSubject},snapshot.revision)} onDecisionAction={(decision,snapshot,action)=>openEditor({type:'decision-action',decision,snapshot,action},snapshot.revision)} onCommand={(command,revision)=>mutate(command as Command,undefined,revision)} /></DeferredPanel>}
        {!unavailableTarget && view==='weekly' && <DeferredPanel label="Weekly planning" canRetry={mayNavigate} onBack={()=>navigate('today')}><WeeklyPlanningView key={weeklyWeek??'current'} initialWeek={weeklyWeek} onReview={(draft,revision)=>openEditor({type:'weekly-review',draft},revision)} workspace={workspace} revision={envelope!.revision} onCommand={(command,revision)=>mutate(command,undefined,revision)} onTask={openTask} onRecurrenceEdit={rule=>openEditor({type:'recurrence',rule})} /></DeferredPanel>}
        {!unavailableTarget && view === 'search' && <SearchView revision={envelope!.revision} value={searchState} onStateChange={(state,mode)=>{setSearchState(state);const url=encodeSearchState(state);if(mode==='replace'){window.history.replaceState({},'',url);locationKey.current=window.location.search;}else writeLocation(url);}} workspace={workspace} onOpen={openEntity} />}
        {!unavailableTarget && view === 'attention' && <AttentionView revision={envelope!.revision} workspace={workspace} onOpen={openEntity} busy={busy||loading||editor!==null} />}
        {!unavailableTarget && view === 'projects' && (milestone ? <MilestoneWorkspace revision={envelope!.revision} workspace={workspace} milestone={milestone} onTask={openTask} onEdit={row=>openEditor({type:'milestone',milestone:row,project:workspace.projects.find(project=>project.id===row.projectId)!})} onNewTask={row=>openEditor({type:'task',projectId:row.projectId,milestoneId:row.id})} onCapture={row=>openEditor({type:'capture',capture:row})} onCommand={command=>mutate(command)} onBack={()=>project?openProject(project):navigate('projects')} /> : project ? <ProjectDetail onUnderstanding={()=>openLocalAnalysis(project.id)} baselineRemovedIds={envelope?.baselineRemovedIds} key={`project-detail:${project.id}`} project={project} workspace={workspace} busy={busy} onBack={() => navigate('projects')} onProjectEdit={() => openEditor({ type: 'project', project })} onProjectLifecycle={(row,action)=>run({type:action==='archive'?'project.archive':'project.restore',id:row.id})} onMilestone={openMilestone} onNewMilestone={() => openEditor({ type: 'milestone', project })} onTask={openTask} onNewTask={() => openEditor({ type: 'task', projectId: project.id })} onPin={pinTask} onApplyBaseline={(project, baselineId) => run({ type: 'baseline.apply', projectId: project.id, baselineId })} /> : <ProjectsView onLocalRepository={()=>openLocalAnalysis()} workspace={workspace} onProject={openProject} onCreate={()=>openEditor({type:'project'})} />)}
        {!unavailableTarget && view==='projects' && !milestone && <TaskBulkActions key={`task-bulk:${project?.id??'portfolio'}`} workspace={workspace} revision={envelope!.revision} projectId={project?.id} onTask={openTask} onCommand={(command,revision)=>mutate(command,undefined,revision)} />}
        {view === 'inbox' && <InboxView revision={envelope!.revision} onBulkCommand={(command,revision)=>mutate(command,undefined,revision)} workspace={workspace} busy={busy} onCreate={() => openEditor({ type: 'capture' })} onEdit={capture => openEditor({ type: 'capture', capture })} onConvert={capture => openEditor({ type: 'convert', capture })} onTask={openTask} onCommand={run} />}
        {view === 'reviews' && envelope && <DeferredPanel label="Briefs and automations" canRetry={mayNavigate} onBack={()=>navigate('today')}><ReviewCenter envelope={envelope} busy={busy||loading} onBaselineRevision={(projectId,snapshot,snapshotHash)=>{if(mayNavigate())openEditor({type:'baseline-revision',projectId,snapshot,snapshotHash});}} onCommand={command=>mutate(command as Command)} onRefreshWorkspace={()=>void refresh()} onDirtyChange={dirty=>{sourceDirtyRef.current=dirty;stream.current?.setBusy(dirty||sourcePendingRef.current||busyRef.current);}} onPendingChange={pending=>{sourcePendingRef.current=pending;polling.current?.setBusy(pending||busyRef.current);stream.current?.setBusy((pending||busyRef.current)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));}} /></DeferredPanel>}
        {view==='local-analysis'&&envelope&&<DeferredPanel label="Repositories" canRetry={mayNavigate} onBack={()=>navigate('projects')}><LocalRepositoryOnboarding key={projectId??'all'} envelope={envelope} projectId={projectId??undefined} busy={busy||loading||editor!==null} pending={unresolved.length>0} onCommand={saveLocalAnalysis} getRetainedSaveCommand={retainedLocalAnalysisSave} onCreateProject={createLocalAnalysisProject} onSessionExpired={expireSession} onReviewTask={(projectId,suggestion)=>{if(mayNavigate())openEditor({type:'task',projectId,suggestion:{...suggestion,draftKey:crypto.randomUUID()}});}} onBusyChange={pending=>{sourcePendingRef.current=pending;polling.current?.setBusy(pending||busyRef.current);stream.current?.setBusy(pending||busyRef.current||sourceDirtyRef.current);}} onDirtyChange={dirty=>{sourceDirtyRef.current=dirty;stream.current?.setBusy(dirty||sourcePendingRef.current||busyRef.current);}}/></DeferredPanel>}
        {view === 'agents' && envelope && <DeferredPanel label="Agents" canRetry={mayNavigate} onBack={()=>navigate('today')}><AgentsView envelope={envelope} busy={busy||loading||editor!==null} onCommand={command=>mutate(command as Command)} onRefreshWorkspace={()=>void refresh()} onOpenJob={()=>{if(mayNavigate())openEditor({type:'agent-job'});}} onOpenBudget={budget=>{if(mayNavigate())openEditor({type:'agent-budget',budget});}} onOpenEnrollment={()=>{if(mayNavigate())openEditor({type:'execution-enrollment'});}} onDirtyChange={dirty=>agentGuard('jobsDirty',dirty)} onPendingChange={pending=>agentGuard('jobsPending',pending)} /></DeferredPanel>}
        {view === 'runtime' && envelope && <RuntimeView envelope={envelope} busy={busy||loading} onCommand={command=>mutate(command as Command)} onEnroll={input=>enrollRuntimeDevice({...input,scopes:['telemetry:write']})} onRefreshWorkspace={()=>void refresh()} onDirtyChange={dirty=>{sourceDirtyRef.current=dirty;stream.current?.setBusy(dirty||sourcePendingRef.current||busyRef.current);}} onPendingChange={pending=>{sourcePendingRef.current=pending;polling.current?.setBusy(pending||busyRef.current);stream.current?.setBusy((pending||busyRef.current)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));}} />}
        {view === 'sources' && envelope && <DeferredPanel label="Sources" canRetry={mayNavigate} onBack={()=>navigate('today')}><SourcesView onDirtyChange={dirty=>{sourceDirtyRef.current=dirty;stream.current?.setBusy(dirty||sourcePendingRef.current||busyRef.current);}} onPendingChange={pending=>{sourcePendingRef.current=pending;polling.current?.setBusy(pending||busyRef.current);stream.current?.setBusy((pending||busyRef.current)||sourceDirtyRef.current||Boolean(editorDraftController.current?.isDirty()));}} envelope={envelope} busy={busy || loading} onRefresh={() => void refresh()} onRestore={restoreWorkspace} onPreviousBackup={loadPreviousBackup} onBackup={()=>mutate({type:'workspace.backup'})} onImport={command=>mutate(command)} onDelete={command=>mutate(command)} onBackupRemove={command=>mutate(command)} /></DeferredPanel>}
      </>}
    </main><footer className="app-footer"><span>CONTROL ROOM</span><span>A little clarity. A steady next step.</span></footer></div>
    {notice && <div className="save-toast" role="status"><Check size={16} />{notice}</div>}
    <EditorOpenerContext.Provider value={editorOpener}><OriginalSaveContext.Provider value={{check:unresolved.find(item=>item.submission.mutationId===editorSubmissionId)?()=>checkOriginal(unresolved.find(item=>item.submission.mutationId===editorSubmissionId)!):undefined}}>
    <DurableDraftProvider baseRevision={editorRevision} controllerRef={editorDraftController} onRecover={recoverSubmission}>
    {editor && <DeferredPanel label="Editor" canRetry={mayNavigate} onBack={()=>navigate('today')}>
    {envelope && editor?.type==='agent-budget' && <JobBudgetEditor key={`agent-budget:${editor.budget?.id??'new'}`} budget={editor.budget} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='execution-enrollment' && <ExecutionEnrollmentDialog disabled={busy||loading} onEnroll={enrollRuntimeDevice} onClose={()=>{if(mayNavigate())closeEditor();}} onRefreshWorkspace={()=>void refresh()} onDirtyChange={dirty=>agentGuard('enrollmentDirty',dirty)} onPendingChange={pending=>agentGuard('enrollmentPending',pending)} />}
    {envelope && editor?.type==='agent-job' && <JobEditor key={`agent-job:${editor.taskId??editor.projectId??'new'}`} envelope={envelope} projectId={editor.projectId} taskId={editor.taskId} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type==='baseline-revision' && <BaselineRevisionEditor key={`baseline-revision:${editor.projectId}:${editor.snapshot.id}:${editor.snapshotHash}`} projectId={editor.projectId} snapshot={editor.snapshot} snapshotHash={editor.snapshotHash} onSave={command=>saveEditor(command as Command)} onClose={closeEditor} />}
    {envelope && editor?.type === 'task' && <TaskEditor revision={envelope.revision} key={`task:${editor.task?.id??`new:${editor.projectId}:${editor.milestoneId??''}:${editor.suggestion?.draftKey??''}`}`} task={editor.task} initialSuggestion={editor.suggestion} projectId={editor.projectId} initialMilestoneId={editor.milestoneId} workspace={envelope!.workspace} onSave={saveEditor} onClose={closeEditor} />}
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
    </DeferredPanel>}
    </DurableDraftProvider></OriginalSaveContext.Provider></EditorOpenerContext.Provider>
  </div></DeviceDraftProvider></SessionExpiredContext.Provider>;
}
