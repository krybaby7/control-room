'use client';

import { useEffect, useRef, useState } from 'react';
import type { Command, Workspace } from '@/lib/types';
import type { ImportDiagnostic, ImportPreview } from '@/lib/import-quarantine';
import type { PlanningRepairOperation, PlanningRepairReport } from '@/lib/import-repair';
import type { PlanningCollection, PlanningMergePreview, PlanningMergeSelection } from '@/lib/workspace-merge';
import { boundedRequest } from '@/lib/save-controller';
import {readImportResponseBytes,readImportResponseJson} from '@/lib/import-response';
import { SessionExpiredError } from '@/lib/workspace-client';
import { dateLabel } from './ui';
import {ArchiveStageRecovery} from './archive-stage-recovery';
import type {ArchiveStageSummary} from '@/lib/attachment-archive-recovery';

const collections: PlanningCollection[] = ['projects', 'milestones', 'tasks', 'captures', 'activity'];
const emptySelection = (): PlanningMergeSelection => ({ projects: [], milestones: [], tasks: [], captures: [], activity: [] });
const PAGE_SIZE = 100;
interface ArchiveSummary { id:string;files:number;bytes:number;expiresAt:number|string;sourceManifestHash:string }
interface StagedFile { archive?:ArchiveSummary; id: string; hash: string; bytes: number; diagnostics: ImportDiagnostic[]; expiresAt: number | string }
interface Review { repairReports?: PlanningRepairReport[]; lineage?: {parentId:string;parentHash:string;steps:number}; preview: ImportPreview; planningBefore: Workspace; planningIncoming: Workspace | null; mergePreview?: PlanningMergePreview }
async function request<T>(url: string, init: RequestInit = {}, decode?: (response: Response,signal?:AbortSignal) => Promise<T>, deadlineMs=15_000): Promise<T> {
  let responseSignal:AbortSignal|undefined;
  try {
    return await boundedRequest(url, { credentials: 'same-origin', cache: 'no-store', ...init }, async response => {
      if (!response.ok) throw new Error(response.status === 400 ? 'The review could not be prepared. Check your selection, including linked projects and milestones, then try again.' : 'This import review is unavailable or expired. Your workspace has not changed.');
      return decode ? decode(response,responseSignal) : await readImportResponseJson<T>(response,{signal:responseSignal});
    }, {deadlineMs,fetch:(input,options)=>{responseSignal=init.signal&&options?.signal?AbortSignal.any([init.signal,options.signal]):options?.signal??init.signal??undefined;return fetch(input,{...options,signal:responseSignal});}});
  } catch (error) {
    if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
    throw error;
  }
}
function downloadOriginal(bytes: ArrayBuffer, id: string, metadataOnly=false) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url; link.download = `control-room-${metadataOnly?'staged-metadata':'original'}-${id}.json`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function recordLabel(value: object) {
  const row = value as Record<string, unknown>;
  return String(row.title ?? row.name ?? row.text ?? row.id ?? 'Record');
}
function replacementChanges(review: Review) {
  if (!review.planningIncoming) return [];
  return collections.flatMap(collection => {
    const before = new Map<string, object>(review.planningBefore[collection].map(row => [row.id, row]));
    const after = new Map<string, object>(review.planningIncoming![collection].map(row => [row.id, row]));
    const diff = review.preview.diff[`planning.${collection}`];
    return [...new Set([...(diff?.added ?? []), ...(diff?.changed ?? []), ...(diff?.deleted ?? [])])].map(id => ({ collection, id, before: before.get(id) ?? null, after: after.get(id) ?? null }));
  });
}
function ReviewRecords({ title, records }: { title: string; records: unknown[] }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(records.length / PAGE_SIZE) - 1);
  const index = Math.min(page, last);
  return <details><summary>{title} ({records.length})</summary>{records.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE).map((record, position) => <pre key={index * PAGE_SIZE + position} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(record, null, 2)}</pre>)}{records.length > PAGE_SIZE && <div className="data-actions"><button type="button" className="button secondary" disabled={index === 0} onClick={() => setPage(index - 1)}>Previous 100</button><span>Page {index + 1} of {last + 1}</span><button type="button" className="button secondary" disabled={index === last} onClick={() => setPage(index + 1)}>Next 100</button></div>}</details>;
}

export function ImportReview({ revision, busy, onImport }: { revision: number; busy: boolean; onImport?: (command: Command) => Promise<void> }) {
  const [stage, setStage] = useState<StagedFile | null>(null);
  const [archive,setArchive]=useState<ArchiveSummary|null>(null);
  const [expired,setExpired]=useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [filename, setFilename] = useState('');
  const [originalId,setOriginalId]=useState<string|null>(null);
  const [repairType,setRepairType]=useState<PlanningRepairOperation['type']>('map-project');
  const [repairCollection,setRepairCollection]=useState<PlanningCollection>('tasks');
  const [repairId,setRepairId]=useState('');
  const [repairTarget,setRepairTarget]=useState('');
  const [repairIndex,setRepairIndex]=useState('0');
  const [selection, setSelection] = useState<PlanningMergeSelection>(emptySelection);
  const [collection, setCollection] = useState<PlanningCollection>('projects');
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<'replace' | 'merge'>('merge');
  const [mergeKey, setMergeKey] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const activeRequests=useRef(new Set<AbortController>());
  useEffect(() => { const epoch = ++generation.current,controllers=activeRequests.current; return () => { generation.current = epoch + 1;for(const controller of controllers)controller.abort();controllers.clear(); }; }, []);
  useEffect(()=>{const clear=()=>{generation.current++;for(const controller of activeRequests.current)controller.abort();activeRequests.current.clear();setExpired(true);setStage(null);setArchive(null);setReview(null);setOriginalId(null);setFilename('');setSelection(emptySelection());setMergeKey(null);setAccepted(false);setWorking('');setError('');setMessage('');};window.addEventListener('control-room-session-expired',clear);return()=>window.removeEventListener('control-room-session-expired',clear);},[]);
  const read=async<T,>(url:string,init:RequestInit={},decode?: (response:Response,signal?:AbortSignal)=>Promise<T>,deadlineMs=15_000):Promise<T>=>{
    const controller=new AbortController();activeRequests.current.add(controller);
    try{return await request<T>(url,{...init,signal:controller.signal},decode,deadlineMs);}finally{activeRequests.current.delete(controller);}
  };
  const endpoint = stage ? `/api/workspace/imports/${encodeURIComponent(stage.id)}` : '';
  const disabled = expired || busy || !!working;
  const selectionKey = JSON.stringify(selection);
  const selectedCount = collections.reduce((count, key) => count + selection[key].length, 0);
  const stale = !!review && review.preview.targetRevision !== revision;
  const diagnostics = review?.preview.diagnostics ?? stage?.diagnostics ?? [];
  const rows = review?.planningIncoming?.[collection] ?? [];
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);

  const recoverArchive=async(summary:ArchiveStageSummary)=>{
    const recovered=summary.recoverableStagedImport;if(disabled||stage||!recovered)return;
    const epoch=generation.current;setWorking('recover');setError('');setMessage('');
    try{const result=await read<Review>(`/api/workspace/imports/${encodeURIComponent(recovered.id)}`);if(generation.current!==epoch)return;
      setStage({...recovered});setArchive({id:summary.id,files:summary.files,bytes:summary.bytes,expiresAt:summary.expiresAt,sourceManifestHash:summary.sourceManifestHash});setMode('replace');setOriginalId(recovered.id);setFilename('Recovered native archive stage');setSelection(emptySelection());setAccepted(false);setMergeKey(null);setReview(result);
    }catch(cause){if(generation.current===epoch)setError(cause instanceof Error?cause.message:'This archive stage is unavailable.');}finally{if(generation.current===epoch)setWorking('');}
  };
  const choose = async (file?: File) => {
    if (!file || disabled || stage) return;
    const epoch = generation.current;
    setWorking('stage'); setError(''); setMessage('');
    try {
      const isArchive=/\.zip$/i.test(file.name)||['application/zip','application/x-zip-compressed'].includes(file.type.toLowerCase());
      if(file.size>(isArchive?220*1024*1024:8_000_000))throw new Error(isArchive?'Choose a ZIP archive no larger than 220 MiB.':'Choose a JSON file no larger than 8,000,000 bytes.');
      // File bytes are sent directly and never placed in a durable draft.
      const staged = await read<StagedFile>(isArchive?'/api/workspace/imports/archive':'/api/workspace/imports', { method: 'POST', headers: isArchive?{ 'Content-Type':'application/zip','X-Workspace-Revision':String(revision)}:{'Content-Type':'application/json'}, body: file },undefined,isArchive?120_000:15_000);
      if(isArchive&&(!staged.archive||typeof staged.archive.id!=='string'||!Number.isSafeInteger(staged.archive.files)||staged.archive.files<0||!Number.isSafeInteger(staged.archive.bytes)||staged.archive.bytes<0||!/^[a-f0-9]{64}$/.test(staged.archive.sourceManifestHash)||!Number.isFinite(new Date(staged.archive.expiresAt).getTime())))throw new Error('Archive staging could not be confirmed. Keep your source ZIP. Any retained stage expires automatically; no workspace import was accepted.');
      if (generation.current !== epoch) return;
      setStage(staged);setArchive(staged.archive?{id:staged.archive.id,files:staged.archive.files,bytes:staged.archive.bytes,expiresAt:staged.archive.expiresAt,sourceManifestHash:staged.archive.sourceManifestHash}:null);setMode(staged.archive?'replace':'merge'); setOriginalId(staged.id); setFilename(file.name); setSelection(emptySelection()); setAccepted(false); setMergeKey(null);
      const result = await read<Review>(`/api/workspace/imports/${encodeURIComponent(staged.id)}`);
      if (generation.current === epoch) setReview(result);
    } catch (cause) { if (generation.current !== epoch) return;setError(cause instanceof Error ? cause.message : 'The file could not be staged.');if(/\.zip$/i.test(file.name)||['application/zip','application/x-zip-compressed'].includes(file.type.toLowerCase()))setMessage('If the archive response was lost, a private stage may remain until expiry. Keep your source ZIP; use Recover staged archives below to locate and review or discard it. Physical copies remain charged until guarded cleanup. No replacement is automatically accepted.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const preview = async (merge: boolean) => {
    if (!stage || (merge&&archive)) return;
    const epoch = generation.current;
    setWorking('preview'); setError(''); setAccepted(false); setMergeKey(null);
    try {
      const result = await read<Review>(endpoint, merge ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'merge', selection }) } : {});
      if (generation.current !== epoch) return;
      setReview(result);
      if (merge && result.mergePreview) setMergeKey(selectionKey);
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'The review could not be prepared.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const original = async (id=stage?.id) => {
    if (!id) return;
    const epoch = generation.current;
    setWorking('download'); setError('');
    try {
      const bytes = await read(`/api/workspace/imports/${encodeURIComponent(id)}?download=1`, {}, async(response,signal)=>(await readImportResponseBytes(response,{signal})).buffer);
      if (generation.current === epoch) downloadOriginal(bytes, id,!!archive);
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'The original file could not be downloaded.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const discard = async () => {
    if (!stage) return;
    const epoch = generation.current;
    setWorking('discard'); setError('');
    try {
      await read(archive?`/api/workspace/imports/archives?id=${encodeURIComponent(archive.id)}`:endpoint,archive?{method:'DELETE'}:{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});
      if (generation.current !== epoch) return;
      setStage(null); setArchive(null); setOriginalId(null); setReview(null); setFilename(''); setSelection(emptySelection()); setMergeKey(null); setAccepted(false); setMessage(archive?'Archive review was discarded. Staged physical copies remain charged until guarded cleanup confirms deletion. Your workspace has not changed.':'Staged file discarded. Your workspace has not changed.');
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'The staged file could not be discarded.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const commit = async () => {
    if (!onImport || !stage || !review || (archive&&mode!=='replace') || diagnostics.length || stale || !accepted || (mode === 'merge' && (!selectedCount || mergeKey !== selectionKey || !review.mergePreview))) return;
    const epoch = generation.current;
    setWorking('commit'); setError(''); setMessage('');
    try {
      await onImport({ type: 'workspace.import.commit', importId: stage.id, hash: stage.hash, targetRevision: review.preview.targetRevision, mode, ...(mode === 'merge' ? { selection } : {}) });
      if (generation.current !== epoch) return;
      setStage(null);setArchive(null);setOriginalId(null);setFilename(''); setReview(null); setAccepted(false); setMessage('The reviewed import was saved.');
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'Import could not be confirmed. Keep this review open.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const repair = async () => {
    if (!stage || disabled || archive) return;
    const epoch=generation.current;
    setWorking('repair');setError('');setMessage('');setAccepted(false);setMergeKey(null);
    try {
      let operation:PlanningRepairOperation;
      if(repairType==='migrate')operation={type:'migrate'};
      else if(repairType==='map-project'){
        if(!['tasks','milestones','captures'].includes(repairCollection))throw new Error('Choose tasks, milestones or captures for a project mapping.');
        operation={type:repairType,collection:repairCollection as 'tasks'|'milestones'|'captures',id:repairId,projectId:repairTarget};
      }else if(repairType==='remove-dependency')operation={type:repairType,taskId:repairId,dependencyId:repairTarget};
      else if(repairType==='exclude-record')operation={type:repairType,collection:repairCollection,id:repairId};
      else {
        if(!/^\d+$/.test(repairIndex)||!Number.isSafeInteger(Number(repairIndex)))throw new Error('Enter the exact zero-based occurrence index.');
        operation={type:repairType,collection:repairCollection,occurrenceIndex:Number(repairIndex),newId:repairTarget};
      }
      const child=await read<StagedFile>(endpoint+'/repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation})});
      if(generation.current!==epoch)return;
      setStage(child);setReview(null);setSelection(emptySelection());setPage(0);
      setMessage('A separate repaired file is ready for review. The earlier file is retained. Your workspace has not changed.');
      const result=await read<Review>(`/api/workspace/imports/${encodeURIComponent(child.id)}`);
      if(generation.current===epoch)setReview(result);
    }catch(cause){if(generation.current===epoch)setError(cause instanceof Error?cause.message:'This repair could not be prepared.');}
    finally{if(generation.current===epoch)setWorking('');}
  };
  const toggle = (id: string, checked: boolean) => {
    setSelection(previous => ({ ...previous, [collection]: checked ? [...previous[collection], id] : previous[collection].filter(value => value !== id) }));
    setMergeKey(null); setAccepted(false);
  };

  if(expired)return <p role="alert">Sign in again to review private imports. Staged review details are locked.</p>;
  return <section className="panel data-panel" aria-labelledby="import-review-heading"><h2 id="import-review-heading">Review an import</h2><p>Choose Planning JSON, a complete JSON bundle or a native ZIP archive. JSON source bytes are held separately for review; choosing it does not change your workspace. No automatic repair, acceptance or completion is performed.</p>
    <input type="file" accept=".json,application/json,.zip,application/zip,application/x-zip-compressed" aria-label="Choose file for import review" disabled={disabled || !!stage} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
    <ArchiveStageRecovery disabled={disabled||!!stage} onRecover={summary=>void recoverArchive(summary)}/>
    {stage && <div className="restore-section"><h3>{filename}</h3><p>{stage.bytes.toLocaleString()} staged bytes · Review expires {dateLabel(new Date(stage.expiresAt).toISOString(), true)}</p><p className="field-hint" style={{ overflowWrap: 'anywhere' }}>File digest: {stage.hash}</p><div className="data-actions"><button type="button" className="button secondary" disabled={disabled} onClick={() => void original()}>{archive?'Download staged metadata JSON (not original ZIP)':originalId===stage.id?'Download original file':'Download repaired file'}</button>{originalId && originalId!==stage.id && <button type="button" className="button secondary" disabled={disabled} onClick={() => void original(originalId)}>Download unchanged original</button>}{review?.lineage && review.lineage.parentId!==originalId && <button type="button" className="button secondary" disabled={disabled} onClick={() => void original(review.lineage!.parentId)}>Download previous repair source</button>}<button type="button" className="button secondary" disabled={disabled} onClick={() => void discard()}>Discard staged file</button><button type="button" className="button secondary" disabled={disabled} onClick={() => void preview(false)}>Refresh review</button></div>
      {archive&&<div className="restore-preview"><h3>Native archive staged for explicit replacement review</h3><p>{archive.files} files · {archive.bytes.toLocaleString()} declared file bytes · Stage expires {dateLabel(new Date(archive.expiresAt).toISOString(),true)}</p><p style={{overflowWrap:'anywhere'}}>Source manifest digest: {archive.sourceManifestHash}</p><p>Keep the original ZIP in your own storage. The server retains rekeyed metadata and separately staged private bytes, not the original ZIP. The metadata download is not your original source file. Only a full reviewed replacement is available; archive module records cannot be merged.</p><p>Repairing staged archive metadata would lose its verified archive binding. Correct the source and stage a new archive instead. Staging never accepts or replaces the workspace automatically.</p></div>}
      {diagnostics.length > 0 && <div role="alert"><h3>This file needs attention</h3><p>It remains separate from your workspace. {archive?'Correct your retained source ZIP and stage a new archive.':'Download the unchanged original for correction.'}</p><ul>{diagnostics.map((item, index) => <li key={index}>{item.path}: {item.code}</li>)}</ul></div>}
      {!archive&&<details><summary>Prepare an explicit repair</summary><p>Choose one exact change to the staged bytes. A new file and change report will be created for a fresh review. The original is retained until its expiry. Unknown versions, unsupported fields and invalid references still prevent importing.</p>
        <form onSubmit={event=>{event.preventDefault();void repair();}}>
          <label className="field"><span className="field-label">Repair operation</span><select aria-label="Repair operation" value={repairType} disabled={disabled} onChange={event=>{const next=event.target.value as PlanningRepairOperation['type'];setRepairType(next);if(next==='map-project'&&!['tasks','milestones','captures'].includes(repairCollection))setRepairCollection('tasks');}}><option value="map-project">Map one record to a project</option><option value="remove-dependency">Remove one task dependency</option><option value="rename-duplicate">Rename an exact duplicate occurrence</option><option value="exclude-record">Exclude one record and retain its content in the report</option><option value="migrate">Migrate a supported planning schema</option></select></label>
          {['map-project','rename-duplicate','exclude-record'].includes(repairType) && <label className="field"><span className="field-label">Repair collection</span><select aria-label="Repair collection" value={repairCollection} disabled={disabled} onChange={event=>setRepairCollection(event.target.value as PlanningCollection)}>{collections.filter(key=>repairType!=='map-project'||['tasks','milestones','captures'].includes(key)).map(key=><option key={key} value={key}>{key}</option>)}</select></label>}
          {['map-project','remove-dependency','exclude-record'].includes(repairType) && <label className="field"><span className="field-label">Exact source record ID</span><input aria-label="Exact source record ID" required maxLength={128} disabled={disabled} value={repairId} onChange={event=>setRepairId(event.target.value)} /></label>}
          {repairType==='rename-duplicate' && <label className="field"><span className="field-label">Exact source occurrence index, starting at zero</span><input aria-label="Exact source occurrence index, starting at zero" required type="number" min="0" step="1" disabled={disabled} value={repairIndex} onChange={event=>setRepairIndex(event.target.value)} /></label>}
          {['map-project','remove-dependency','rename-duplicate'].includes(repairType) && <label className="field"><span className="field-label">{repairType==='map-project'?'Target project ID':repairType==='remove-dependency'?'Dependency ID to remove':'New globally unique record ID'}</span><input aria-label={repairType==='map-project'?'Target project ID':repairType==='remove-dependency'?'Dependency ID to remove':'New globally unique record ID'} required maxLength={128} disabled={disabled} value={repairTarget} onChange={event=>setRepairTarget(event.target.value)} /></label>}
          {repairType==='rename-duplicate' && <p>Inspect the downloaded source to identify the exact collection index. Ambiguous references are refused.</p>}
          {repairType==='exclude-record' && <p role="alert">The selected record will be absent from the repaired file. Its full content is retained in the repair report. References are preserved and may need another explicit repair.</p>}
          <button type="submit" className="button secondary" disabled={disabled || (review?.repairReports?.length??0)>=8}>{working==='repair'?'Preparing repaired review…':'Create separate repaired review'}</button>
        </form>
      </details>}
      {!!review?.repairReports?.length && <div className="restore-preview"><h3>Repair history for this file</h3><p>{review.repairReports.length} explicit repair operations. Review the original source claims, changes and any excluded content before importing. These reports do not approve or complete any work.</p><ReviewRecords title="Repair operations and source hashes" records={review.repairReports.map(report=>({sourceHash:report.sourceHash,operation:report.operation,warnings:report.warnings}))} /><ReviewRecords title="Repair changes, before and after" records={review.repairReports.flatMap(report=>report.changes)} /><ReviewRecords title="Excluded records retained for recovery" records={review.repairReports.flatMap(report=>report.excludedRecords)} /></div>}
      {review && diagnostics.length === 0 && review.planningIncoming && <><p>Reviewed against saved revision {review.preview.targetRevision}. Attachment completeness: {review.preview.attachmentCompleteness}.</p><p>Module versions: {Object.entries(review.preview.moduleVersions).map(([name, version]) => `${name} v${version}`).join(', ') || 'Planning only'}. {review.preview.backupAvailable ? 'A previous recovery export is available.' : 'No previous recovery export was reported.'}</p>
        <div style={{ overflowX: 'auto' }}><table><thead><tr><th scope="col">Collection</th><th scope="col">Current</th><th scope="col">Incoming</th><th scope="col">Added</th><th scope="col">Absent from incoming</th><th scope="col">Changed</th></tr></thead><tbody>{Object.entries(review.preview.diff).map(([key, diff]) => <tr key={key}><th scope="row">{key}</th><td>{diff.before}</td><td>{diff.after}</td><td>{diff.added.length}</td><td>{diff.deleted.length}</td><td>{diff.changed.length}</td></tr>)}</tbody></table></div>
        <label className="field"><span className="field-label">Import mode</span><select aria-label="Import mode" value={mode} disabled={disabled} onChange={event => { setMode(event.target.value as 'merge' | 'replace'); setAccepted(false); }}>{!archive&&<option value="merge">Merge selected planning records</option>}<option value="replace">Replace entire workspace</option></select></label>
        {mode === 'merge' ? <><p>Start with no records selected. Choose each source record and any linked projects, milestones or dependencies it needs. Available module records are not merged by this action. New tasks remain proposals; existing task completion, acceptance and weekly commitments are preserved.</p><p>{collections.map(key => `${key}: ${selection[key].length}/${review.planningIncoming![key].length} selected`).join(' · ')}</p>
          <label className="field"><span className="field-label">Source collection</span><select aria-label="Source collection" value={collection} disabled={disabled} onChange={event => { setCollection(event.target.value as PlanningCollection); setPage(0); }}>{collections.map(key => <option key={key} value={key}>{key} ({review.planningIncoming![key].length})</option>)}</select></label>
          <p>Showing {rows.length ? page * PAGE_SIZE + 1 : 0}–{Math.min((page + 1) * PAGE_SIZE, rows.length)} of {rows.length} source records.</p>
          {pageRows.map(row => <div className="capture-preview" key={row.id}><label><input type="checkbox" disabled={disabled} checked={selection[collection].includes(row.id)} onChange={event => toggle(row.id, event.target.checked)} /> {recordLabel(row)}</label><small> {row.id}</small><details><summary>Review source record</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(row, null, 2)}</pre></details></div>)}
          <div className="data-actions"><button type="button" className="button secondary" disabled={disabled || page === 0} onClick={() => setPage(page - 1)}>Previous 100</button><span>Page {page + 1} of {lastPage + 1}</span><button type="button" className="button secondary" disabled={disabled || page >= lastPage} onClick={() => setPage(page + 1)}>Next 100</button><button type="button" className="button secondary" disabled={disabled || !selectedCount} onClick={() => { setSelection(emptySelection()); setMergeKey(null); setAccepted(false); }}>Clear all selections</button><button type="button" className="button primary" disabled={disabled || !selectedCount} onClick={() => void preview(true)}>Preview selected merge</button></div>
          {mergeKey === selectionKey && review.mergePreview && <div className="restore-preview"><h3>Selected merge review</h3><p>{review.mergePreview.added} added · {review.mergePreview.changed} changed · {review.mergePreview.conflicts.length} existing record collisions · {review.mergePreview.sourceClaims.length} imported lifecycle claims retained as source history.</p><ReviewRecords title="Existing record collisions, before and after" records={review.mergePreview.conflicts} /><ReviewRecords title="Imported source claims" records={review.mergePreview.sourceClaims} /><ReviewRecords title="Resulting selected records" records={collections.flatMap(key => review.mergePreview!.workspace[key].filter(row => selection[key].includes(row.id)).map(record => ({ collection: key, record })))} /></div>}
        </> : <div className="restore-preview" role="alert"><h3>Replace the entire workspace</h3><p>This replaces planning and the supported replaceable module records shown in the comparison, including records absent from the incoming file. Imported audit history is appended to the retained history ledger. A recovery snapshot must be saved in the same operation. If validation or backup preparation fails, the replacement is rejected.</p><p>Imported completion and acceptance values are source claims from this file. Review every changed lifecycle value before proceeding. {archive?'Download the staged metadata and retain your original ZIP to inspect source content.':'Download the original file to inspect the module content listed above.'}</p><ReviewRecords title="Replacement planning changes, before and after" records={replacementChanges(review)} /><ReviewRecords title="Incoming planning records" records={collections.flatMap(key => review.planningIncoming![key].map(record => ({ collection: key, record })))} /></div>}
        {stale && <p role="alert">Your workspace changed after this review. Refresh the review and check it again before importing.</p>}
        <label className="check-card"><input type="checkbox" checked={accepted} disabled={disabled || stale || (mode === 'merge' && mergeKey !== selectionKey)} onChange={event => setAccepted(event.target.checked)} /><span>{mode === 'replace' ? 'I reviewed the full replacement and its recovery snapshot requirement.' : 'I reviewed this selected merge and its existing record changes.'}</span></label>
        <button type="button" className="button primary" disabled={disabled || !onImport || stale || !accepted || (mode === 'merge' && (!selectedCount || mergeKey !== selectionKey))} onClick={() => void commit()}>{working === 'commit' ? 'Saving reviewed import…' : mode === 'replace' ? 'Replace entire workspace with reviewed file' : 'Import reviewed selection'}</button>
        {!onImport && <p className="field-hint">You can review and download this file. Import saving is unavailable in this session.</p>}
      </>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="restore-message" role="status">{message}</p>}
  </section>;
}
