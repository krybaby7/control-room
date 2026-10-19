'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import { boundedRequest } from '@/lib/save-controller';
import { SessionExpiredError } from '@/lib/workspace-client';
import type { BackupManifest } from '@/lib/workspace-backups';
import type { Command } from '@/lib/types';
import type { WorkspaceBundle } from '@/lib/workspace-export';
import { dateLabel } from './ui';

type RetainedGeneration={id:string;indexHash:string;generationHash:string;files:number;archiveBytes:number;chargedBytes:number;chargedParts:number;pendingCleanupCount:number};
function retainedGenerationPage(value:unknown):{items:RetainedGeneration[];nextAfter:string|null}{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'items')||!Object.hasOwn(value,'nextAfter'))throw new Error('Retained generation history is unavailable.');
 const page=value as {items?:unknown;nextAfter?:unknown};if(!Array.isArray(page.items)||page.items.length>25||page.nextAfter!==null&&(typeof page.nextAfter!=='string'||page.nextAfter.length<1||page.nextAfter.length>128))throw new Error('Retained generation history is unavailable.');
 const items=page.items as RetainedGeneration[];for(const row of items){if(!row||typeof row!=='object'||Object.keys(row).length!==8||!['id','indexHash','generationHash','files','archiveBytes','chargedBytes','chargedParts','pendingCleanupCount'].every(key=>Object.hasOwn(row,key))||typeof row.id!=='string'||row.id.length<1||row.id.length>128||typeof row.indexHash!=='string'||!/^[a-f0-9]{64}$/.test(row.indexHash)||typeof row.generationHash!=='string'||!/^[a-f0-9]{64}$/.test(row.generationHash)||!Number.isSafeInteger(row.files)||row.files<0||row.files>500||!Number.isSafeInteger(row.archiveBytes)||row.archiveBytes<1||row.archiveBytes>20_000_000||!Number.isSafeInteger(row.chargedBytes)||row.chargedBytes<0||row.chargedBytes>row.archiveBytes||!Number.isSafeInteger(row.chargedParts)||row.chargedParts<1||row.chargedParts>5||!Number.isSafeInteger(row.pendingCleanupCount)||row.pendingCleanupCount<0||row.pendingCleanupCount>5)throw new Error('Retained generation history is unavailable.');}
 if(new Set(items.map(row=>row.id)).size!==items.length||page.nextAfter!==null&&page.nextAfter!==items.at(-1)?.id)throw new Error('Retained generation history is unavailable.');return {items,nextAfter:page.nextAfter as string|null};
}
async function cleanupResponse(response:Response){
 if(!response.ok)throw new Error('Cleanup could not be confirmed. Refresh archive bookkeeping before an explicit retry.');
 const value=await response.json() as {status:string;reason?:string;purgedParts:number;retainedBytes:number;physicalDeletion:boolean};
 if(!value||typeof value!=='object'||Object.keys(value).length!==(value.reason===undefined?4:5)||Object.keys(value).some(key=>!['status','reason','purgedParts','retainedBytes','physicalDeletion'].includes(key))||!['completed','partial','blocked','uncertain'].includes(value.status)||value.reason!==undefined&&!['pending_upload','storage_unavailable','cleanup_unconfirmed','authorization_stale'].includes(value.reason)||!Number.isSafeInteger(value.purgedParts)||value.purgedParts<0||value.purgedParts>5||!Number.isSafeInteger(value.retainedBytes)||value.retainedBytes<0||value.retainedBytes>20_000_000||typeof value.physicalDeletion!=='boolean'||value.physicalDeletion!==(value.purgedParts>0)||value.status==='completed'&&value.retainedBytes!==0)throw new Error('Cleanup response was incomplete. Refresh before retrying.');return value;
}
type RetiredArchive = {id:string;indexHash:string;retiredAt:string;files:number;archiveBytes:number;chargedBytes:number;chargedParts:number;pendingUploadCount:number;pendingCleanupCount:number;cleanupAuthorized:boolean};
function retiredPage(value:unknown):{items:RetiredArchive[];nextAfter:string|null}{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Retired archive history is unavailable.');if(Object.keys(value).length!==2||!Object.hasOwn(value,'items')||!Object.hasOwn(value,'nextAfter'))throw new Error('Retired archive history is unavailable.');const page=value as {items?:unknown;nextAfter?:unknown};
 if(!Array.isArray(page.items)||page.items.length>25||page.nextAfter!==null&&(typeof page.nextAfter!=='string'||page.nextAfter.length<1||page.nextAfter.length>128))throw new Error('Retired archive history is unavailable.');
 const items=page.items as RetiredArchive[];for(const row of items){if(!row||typeof row!=='object'||Object.keys(row).length!==10||!['id','indexHash','retiredAt','files','archiveBytes','chargedBytes','chargedParts','pendingUploadCount','pendingCleanupCount','cleanupAuthorized'].every(key=>Object.hasOwn(row,key))||typeof row.id!=='string'||row.id.length<1||row.id.length>128||typeof row.indexHash!=='string'||!/^[a-f0-9]{64}$/.test(row.indexHash)||typeof row.cleanupAuthorized!=='boolean'||typeof row.retiredAt!=='string'||!Number.isFinite(Date.parse(row.retiredAt))||!Number.isSafeInteger(row.files)||row.files<0||row.files>500||!Number.isSafeInteger(row.archiveBytes)||row.archiveBytes<1||row.archiveBytes>20_000_000||!Number.isSafeInteger(row.chargedBytes)||row.chargedBytes<0||row.chargedBytes>row.archiveBytes||[row.chargedParts,row.pendingUploadCount,row.pendingCleanupCount].some(count=>!Number.isSafeInteger(count)||count<0||count>5))throw new Error('Retired archive history is unavailable.');}
 if(new Set(items.map(row=>row.id)).size!==items.length||page.nextAfter!==null&&page.nextAfter!==items.at(-1)?.id)throw new Error('Retired archive history is unavailable.');
 return {items,nextAfter:page.nextAfter as string|null};
}
type FileArchive = {status:'ready'|'preparing'|'failed'|'retired';bytes:number;files:number;sha256:string|null};
type PublicBackup = Omit<BackupManifest, 'ownerScope'|'fileArchive'> & { pinned: boolean;fileArchive?:FileArchive };
function validFileArchive(value:unknown):value is FileArchive{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;const row=value as Record<string,unknown>;return Object.keys(row).length===4&&['status','bytes','files','sha256'].every(key=>Object.hasOwn(row,key))&&['ready','preparing','failed','retired'].includes(String(row.status))&&typeof row.bytes==='number'&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=256*1024*1024&&typeof row.files==='number'&&Number.isSafeInteger(row.files)&&row.files>=0&&row.files<=500&&(row.sha256===null||typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256));}

type AuthorizationArchive=Pick<RetiredArchive,'id'|'indexHash'|'cleanupAuthorized'|'chargedParts'|'pendingUploadCount'>;
type AuthorizationCandidate=Pick<PublicBackup,'id'|'sha256'|'status'|'fileArchive'>;
export function retiredArchiveAuthorizationRequest(archive:AuthorizationArchive,candidate:AuthorizationCandidate|undefined,confirmed:boolean){
 if(!confirmed||archive.cleanupAuthorized||archive.chargedParts<1||archive.pendingUploadCount!==0||!candidate||candidate.id===archive.id||candidate.status!=='ready'||candidate.fileArchive?.status!=='ready'||!candidate.fileArchive.sha256||!/^[a-f0-9]{64}$/.test(candidate.fileArchive.sha256)||!/^[a-f0-9]{64}$/.test(candidate.sha256)||!/^[a-f0-9]{64}$/.test(archive.indexHash))throw new Error('Review a complete native file recovery point and explicitly consent before renewing cleanup authorization.');
 return {action:'reauthorize' as const,id:archive.id,indexHash:archive.indexHash,newerId:candidate.id,newerSha256:candidate.sha256,confirmed:true as const};
}
export function RetiredAuthorizationConsent({confirmed,disabled,onChange}:{confirmed:boolean;disabled:boolean;onChange:(value:boolean)=>void}){
 return <label className="check-card"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event=>onChange(event.target.checked)}/><span>I reviewed this retired archive and the selected newer complete native file recovery point. Renew cleanup authorization only; do not delete files.</span></label>;
}

async function privateRequest<T>(url: string, decode: (response: Response) => Promise<T>): Promise<T> {
  try {
    return await boundedRequest(url, { credentials: 'same-origin', cache: 'no-store' }, async response => {
      if (!response.ok) throw new Error('This download is unavailable. Your workspace has not changed.');
      return decode(response);
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
    throw error;
  }
}
async function fetchBundle(url: string) {
  return privateRequest(url, async response => {
    const text = await response.text();
    const bundle = JSON.parse(text) as WorkspaceBundle;
    if (bundle.format !== 'control-room' || bundle.bundleVersion !== 1 || !Number.isSafeInteger(bundle.source?.workspaceRevision) || !bundle.modules || !Array.isArray(bundle.attachments) || !['complete', 'metadata-only'].includes(bundle.completeness)) throw new Error('The export response was incomplete. Try again.');
    return { text, bundle, bytes: new TextEncoder().encode(text).byteLength };
  });
}
function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function completeness(bundle: WorkspaceBundle) {
  return bundle.completeness === 'complete' ? 'All declared bundle content is included.' : 'Metadata only; attachment files are not included.';
}
export function CompleteBundleExport({ disabled = false }: { disabled?: boolean }) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  useEffect(() => { const epoch = ++generation.current; return () => { generation.current = epoch + 1; }; }, []);
  const exportBundle = async () => {
    const epoch = generation.current;
    setWorking(true); setMessage('');
    try {
      const result = await fetchBundle('/api/workspace/export');
      if (generation.current !== epoch) return;
      download(result.text, `control-room-bundle-${new Date().toISOString().slice(0, 10)}-r${result.bundle.source.workspaceRevision}.json`);
      setMessage(`Downloaded ${result.bytes.toLocaleString()} bytes from revision ${result.bundle.source.workspaceRevision}. ${completeness(result.bundle)}`);
    } catch (error) { if (generation.current === epoch) setMessage(error instanceof Error ? error.message : 'Export could not be downloaded.'); }
    finally { if (generation.current === epoch) setWorking(false); }
  };
  return <div><button className="button primary" disabled={disabled || working} onClick={() => void exportBundle()}><ArrowDownToLine size={15} />{working ? 'Preparing bundle…' : 'Export complete bundle'}</button>{message && <p className="field-hint" role="status">{message}</p>}</div>;
}

export function BackupHistory({ busy, onBackup, targetRevision, onBackupRemove }: { busy: boolean; onBackup?: () => Promise<void>; targetRevision: number; onBackupRemove?: (command: Command) => Promise<void> }) {
  const [backups, setBackups] = useState<PublicBackup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [retained,setRetained]=useState<RetainedGeneration[]>([]),[retainedNext,setRetainedNext]=useState<string|null>(null),[retainedError,setRetainedError]=useState(''),[retainedReview,setRetainedReview]=useState<RetainedGeneration|null>(null),[retainedConfirmed,setRetainedConfirmed]=useState(false);
  const [retired,setRetired]=useState<RetiredArchive[]>([]),[retiredNext,setRetiredNext]=useState<string|null>(null),[retiredError,setRetiredError]=useState(''),[cleanup,setCleanup]=useState<RetiredArchive|null>(null),[cleanupConfirmed,setCleanupConfirmed]=useState(false);
  const [reauthorization,setReauthorization]=useState<RetiredArchive|null>(null),[reauthorizationCandidate,setReauthorizationCandidate]=useState(''),[reauthorizationConfirmed,setReauthorizationConfirmed]=useState(false);
  const [removal, setRemoval] = useState<{ backup: PublicBackup; newer: PublicBackup; targetRevision: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const loadRetired=useCallback(async(epoch:number,after?:string)=>{const value=await privateRequest('/api/workspace/backups/retired-files'+(after?'?after='+encodeURIComponent(after):''),async response=>retiredPage(await response.json()));if(generation.current===epoch){setRetired(value.items);setRetiredNext(value.nextAfter);setRetiredError('');setCleanup(null);setCleanupConfirmed(false);setReauthorization(null);setReauthorizationCandidate('');setReauthorizationConfirmed(false);}},[]);
  const loadRetained=useCallback(async(epoch:number,after?:string)=>{const value=await privateRequest('/api/workspace/backups/retired-files?action=retained'+(after?'&after='+encodeURIComponent(after):''),async response=>retainedGenerationPage(await response.json()));if(generation.current===epoch){setRetained(value.items);setRetainedNext(value.nextAfter);setRetainedError('');setRetainedReview(null);setRetainedConfirmed(false);}},[]);
  const load = useCallback(async (epoch: number) => {
    const result = await privateRequest('/api/workspace/backups', async response => {
      const value = await response.json() as { backups: PublicBackup[] };
      if (!Array.isArray(value.backups) || value.backups.length > 10 || value.backups.some(backup=>backup.fileArchive!==undefined&&!validFileArchive(backup.fileArchive))) throw new Error('Recovery history could not be read.');
      return value.backups;
    });
    if (generation.current === epoch) { setBackups(result); setLoaded(true); setRemoval(null); setConfirmed(false); }
    try{await loadRetired(epoch);}catch{if(generation.current===epoch)setRetiredError('Retired file archive history is unavailable. Refresh before cleanup.');}
    try{await loadRetained(epoch);}catch{if(generation.current===epoch)setRetainedError('Retained generation history is unavailable. Refresh before reviewing redundant files.');}
  }, [loadRetired,loadRetained]);
  useEffect(() => {
    const epoch = ++generation.current;
    void load(epoch).catch(() => { if (generation.current === epoch) setError('Recovery history could not be loaded. Refresh to try again.'); });
    return () => { generation.current = epoch + 1; };
  }, [load]);
  const refresh = async () => {
    const epoch = generation.current;
    setWorking('refresh'); setError(''); setRemoval(null); setConfirmed(false);
    try { await load(epoch); }
    catch { if (generation.current === epoch) setError('Recovery history could not be loaded. Refresh to try again.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const create = async () => {
    if (!onBackup) return;
    const epoch = generation.current;
    setWorking('create'); setError(''); setMessage('');
    try {
      await onBackup();
      if (generation.current !== epoch) return;
      setMessage('Recovery snapshot created.');
      await load(epoch);
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'Recovery snapshot could not be confirmed.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const downloadBackup = async (backup: PublicBackup) => {
    const epoch = generation.current;
    setWorking(backup.id); setError(''); setMessage('');
    try {
      const result = await fetchBundle(`/api/workspace/backups/${encodeURIComponent(backup.id)}`);
      if (generation.current !== epoch) return;
      download(result.text, `control-room-recovery-${backup.id}-r${result.bundle.source.workspaceRevision}.json`);
      setMessage(`Verified recovery bundle downloaded: ${result.bytes.toLocaleString()} bytes. ${completeness(result.bundle)}`);
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'The recovery bundle could not be verified.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const validPoint = (backup: PublicBackup) => backup.status === 'ready' && /^[a-f0-9]{64}$/.test(backup.sha256) && Number.isSafeInteger(backup.sourceRevision) && backup.sourceRevision > 0 && Number.isFinite(Date.parse(backup.createdAt)) && Number.isSafeInteger(backup.bytes) && backup.bytes > 0 && (backup.missingAttachments.length === 0 || backup.fileArchive?.status==='ready'&&backup.fileArchive.sha256!==null) && backup.completeModules.includes('planning');
  const newerPoint = (selected: PublicBackup) => backups.filter(candidate => candidate.id !== selected.id && validPoint(candidate) && (!selected.fileArchive||candidate.fileArchive?.status==='ready'&&candidate.fileArchive.sha256!==null) && (candidate.sourceRevision > selected.sourceRevision || candidate.sourceRevision === selected.sourceRevision && Date.parse(candidate.createdAt) > Date.parse(selected.createdAt))).sort((left, right) => right.sourceRevision - left.sourceRevision || Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const reviewRemoval = (backup: PublicBackup) => {
    const newer = newerPoint(backup);
    if (!validPoint(backup) || !newer) return;
    setCleanup(null);setCleanupConfirmed(false);setRetainedReview(null);setRetainedConfirmed(false);setRemoval({ backup, newer, targetRevision }); setConfirmed(false); setError(''); setMessage('');
  };
  const removeSnapshot = async () => {
    if (!removal || !onBackupRemove || !confirmed || removal.targetRevision !== targetRevision || busy || working || retained.some(row=>row.id===removal.backup.id&&row.chargedParts>0)) return;
    const epoch = generation.current;
    setWorking('remove'); setError(''); setMessage('');
    try {
      await onBackupRemove({ type: 'workspace.backup.remove', id: removal.backup.id, sha256: removal.backup.sha256, targetRevision: removal.targetRevision });
      if (generation.current !== epoch) return;
      setRemoval(null); setConfirmed(false); setMessage(removal.backup.fileArchive?'The selected logical snapshot was removed and its file archive retired. Physical chunks remain charged until a separate explicit cleanup confirms absence. The newer file recovery point was retained.':'The selected recovery snapshot was permanently removed. The newer verified recovery point was retained.');
      try { await load(epoch); } catch { if (generation.current === epoch) setError('Snapshot removal was confirmed, but recovery history could not refresh. Refresh the list to check it.'); }
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'Snapshot removal could not be confirmed. This review is retained.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const retiredPageAction=async(after?:string)=>{const epoch=generation.current;setWorking('retired-page');setRetiredError('');try{await loadRetired(epoch,after);}catch{if(generation.current===epoch)setRetiredError('Retired file archive history could not refresh.');}finally{if(generation.current===epoch)setWorking('');}};
  const cleanupFiles=async()=>{
    if(!cleanup||!cleanupConfirmed||busy||working||cleanup.pendingUploadCount>0||!cleanup.cleanupAuthorized)return;const reviewed=cleanup,epoch=generation.current;setWorking('cleanup');setError('');setMessage('');
    try{const result=await boundedRequest('/api/workspace/backups/retired-files',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({action:'retired',id:reviewed.id,indexHash:reviewed.indexHash,confirmed:true})},cleanupResponse);
      if(generation.current!==epoch)return;setMessage(result.status==='completed'?(result.physicalDeletion?'Physical absence and quota release were confirmed for '+result.purgedParts+' archive parts. Immutable retirement history is retained.':'No charged parts remain. This response does not report a new physical deletion.'):'Cleanup '+result.status+'. '+result.retainedBytes.toLocaleString()+' bytes remain charged. '+(result.reason==='authorization_stale'?'This historical retirement has no current cleanup authorization. Files remain retained.':result.reason==='pending_upload'?'An earlier upload outcome is unconfirmed.':result.reason==='storage_unavailable'?'Private storage is unavailable.':'Review current bookkeeping before any explicit retry.'));
      setCleanup(null);setCleanupConfirmed(false);try{await loadRetired(epoch);}catch{if(generation.current===epoch)setRetiredError('Cleanup responded, but current bookkeeping could not refresh. Refresh before another action.');}
    }catch(cause){if(cause instanceof SessionExpiredError)window.dispatchEvent(new Event('control-room-session-expired'));if(generation.current===epoch)setError(cause instanceof Error?cause.message:'Cleanup could not be confirmed.');}finally{if(generation.current===epoch)setWorking('');}
  };
  const retainedPageAction=async(after?:string)=>{const epoch=generation.current;setWorking('retained-page');setRetainedError('');try{await loadRetained(epoch,after);}catch{if(generation.current===epoch)setRetainedError('Retained generation history could not refresh.');}finally{if(generation.current===epoch)setWorking('');}};
  const cleanupRetainedFiles=async()=>{
   if(!retainedReview||!retainedConfirmed||busy||working)return;const reviewed=retainedReview,epoch=generation.current;setWorking('retained-cleanup');setError('');setMessage('');
   try{const result=await boundedRequest('/api/workspace/backups/retired-files',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({action:'retained',id:reviewed.id,indexHash:reviewed.indexHash,generationHash:reviewed.generationHash,confirmed:true})},cleanupResponse);if(generation.current!==epoch)return;
    setMessage(result.status==='completed'?'The reviewed redundant generation has no charged parts remaining. The current ready recovery point was retained; no logical snapshot was removed.':'Retained-generation cleanup '+result.status+'. '+result.retainedBytes.toLocaleString()+' bytes remain charged. Current recovery data is retained; refresh before an explicit retry.');
    setRetainedReview(null);setRetainedConfirmed(false);try{await loadRetained(epoch);}catch{if(generation.current===epoch)setRetainedError('Cleanup responded, but generation bookkeeping could not refresh. Refresh before another action.');}
   }catch(cause){if(cause instanceof SessionExpiredError)window.dispatchEvent(new Event('control-room-session-expired'));if(generation.current===epoch)setError(cause instanceof Error?cause.message:'Retained-generation cleanup could not be confirmed.');}finally{if(generation.current===epoch)setWorking('');}
  };
  const reauthorizationCandidates=backups.filter(row=>row.status==='ready'&&row.fileArchive?.status==='ready'&&row.fileArchive.sha256!==null&&/^[a-f0-9]{64}$/.test(row.sha256));
  const reauthorize=async()=>{
   if(!reauthorization||busy||working)return;
   let body;try{body=retiredArchiveAuthorizationRequest(reauthorization,reauthorizationCandidates.find(row=>row.id===reauthorizationCandidate),reauthorizationConfirmed);}catch(cause){setError(cause instanceof Error?cause.message:'Review this authorization again.');return;}
   const epoch=generation.current;setWorking('reauthorize');setError('');setMessage('');
   try{await boundedRequest('/api/workspace/backups/retired-files',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(body)},async response=>{
    if(!response.ok)throw new Error('Cleanup authorization could not be renewed. The selected point must be strictly newer and its complete native files must verify; refresh and review again.');
    const result=await response.json() as Record<string,unknown>;if(!result||typeof result!=='object'||Object.keys(result).length!==4||!['status','id','indexHash','executionEpoch'].every(key=>Object.hasOwn(result,key))||result.status!=='authorized'||result.id!==body.id||result.indexHash!==body.indexHash||!Number.isSafeInteger(result.executionEpoch)||Number(result.executionEpoch)<0)throw new Error('Authorization response could not be verified. Refresh bookkeeping before another action.');
   });if(generation.current!==epoch)return;setMessage('Cleanup authorization was renewed after complete newer file recovery verification. No files were deleted and no quota was released. Review physical cleanup separately.');setReauthorization(null);setReauthorizationCandidate('');setReauthorizationConfirmed(false);try{await loadRetired(epoch);}catch{if(generation.current===epoch)setRetiredError('Authorization responded, but bookkeeping could not refresh. Refresh before reviewing cleanup.');}
   }catch(cause){if(cause instanceof SessionExpiredError)window.dispatchEvent(new Event('control-room-session-expired'));if(generation.current===epoch)setError(cause instanceof Error?cause.message:'Authorization could not be confirmed.');}finally{if(generation.current===epoch)setWorking('');}
  };
  const disabled = busy || !!working;
  return <section className="panel data-panel" aria-labelledby="backup-history-heading"><div className="section-heading"><div><h2 id="backup-history-heading">Recovery snapshots</h2><p>Download verified bundles of saved planning and available module records. Complete bundle restoration is not available here. Snapshots are never automatically evicted when storage fills; review a selected older snapshot for removal to free capacity.</p></div></div>
    <div className="data-actions">{onBackup && <button className="button primary" disabled={disabled} onClick={() => void create()}>{working === 'create' ? 'Creating snapshot…' : 'Create recovery snapshot'}</button>}<button className="button secondary" disabled={disabled} onClick={() => void refresh()}><RefreshCw size={15} />Refresh recovery history</button></div>
    {loaded && <p className="data-metadata">{backups.length}/10 snapshots · {backups.reduce((total, item) => total + item.bytes, 0).toLocaleString()} bytes in listed snapshots</p>}
    {loaded && backups.length === 0 && <p>No recovery snapshots have been saved.</p>}
    {backups.map(backup => <article className="capture-preview" key={backup.id}><h3>{dateLabel(backup.createdAt, true)}</h3><p>Source revision {backup.sourceRevision} · {backup.reason} · {backup.pinned ? 'Pinned' : 'Not pinned'} · {backup.status}</p><p>{backup.bytes.toLocaleString()} bytes · Modules: {backup.completeModules.join(', ') || 'None recorded'}</p><p>{backup.missingAttachments.length ? backup.fileArchive?`Metadata JSON excludes ${backup.missingAttachments.length} attachment files; see the separate dated archive record.`:`${backup.missingAttachments.length} attachment files are missing.` : 'No missing attachment files recorded.'}</p>{backup.fileArchive?<div aria-label="Dated file archive record"><p>File archive recorded with this snapshot: {backup.fileArchive.status} · {backup.fileArchive.bytes.toLocaleString()} ZIP bytes · {backup.fileArchive.files} files.</p><p className="field-hint">This is saved bookkeeping from {dateLabel(backup.createdAt,true)}, not a fresh availability check. Download rechecks the private archive and physical files; failure has no metadata-only fallback.</p><p style={{overflowWrap:'anywhere'}}>Archive index SHA-256: {backup.fileArchive.sha256??'Not recorded'}</p>{backup.fileArchive.status==='ready'&&backup.fileArchive.sha256?<a className="button secondary" aria-disabled={disabled} tabIndex={disabled?-1:undefined} onClick={event=>{if(disabled)event.preventDefault();}} href={`/api/workspace/backups/${encodeURIComponent(backup.id)}/archive`} download>Download native file archive</a>:<p className="field-hint">A native file archive download is unavailable for this saved status.</p>}</div>:<p className="field-hint">Metadata-only recovery snapshot; no native file archive is recorded.</p>}<p className="field-hint">The separate JSON bundle contains metadata, not attachment bytes.</p><button className="button secondary" disabled={disabled || backup.status !== 'ready'} onClick={() => void downloadBackup(backup)}><ArrowDownToLine size={15} />{working === backup.id ? 'Verifying download…' : 'Download verified bundle'}</button><button type="button" className="button secondary" disabled={disabled || !validPoint(backup) || !newerPoint(backup) || retained.some(row=>row.id===backup.id&&row.chargedParts>0)} onClick={() => reviewRemoval(backup)}>Review snapshot removal</button>{retained.some(row=>row.id===backup.id&&row.chargedParts>0)&&<p className="field-hint">Review and clean redundant retained generations before removing this logical recovery point.</p>}{!newerPoint(backup) && <p className="field-hint">Keep a newer verified recovery point before removing this snapshot.</p>}</article>)}
    {removal && <div className="restore-preview" aria-labelledby="snapshot-removal-heading"><h3 id="snapshot-removal-heading">Review permanent snapshot removal</h3><p>{removal.backup.fileArchive?'This removes the selected logical snapshot and retires its archive. Physical chunks stay charged until a separate explicit cleanup confirms their absence. ':''}This permanently removes only the selected recovery snapshot. Its saved contents will no longer be available from recovery history. Download it first if you want to keep a separate copy. Your current planning records are retained.</p><dl><dt>Created</dt><dd>{removal.backup.createdAt}</dd><dt>Source revision</dt><dd>{removal.backup.sourceRevision}</dd><dt>Bytes removed</dt><dd>{removal.backup.bytes.toLocaleString()}</dd><dt>Retention</dt><dd>{removal.backup.pinned ? 'Pinned — this explicit removal also removes its pinned copy.' : 'Not pinned'}</dd><dt>Digest</dt><dd style={{ overflowWrap: 'anywhere' }}>{removal.backup.sha256}</dd></dl><p>Newer verified recovery point retained: {removal.newer.createdAt}, source revision {removal.newer.sourceRevision}, {removal.newer.bytes.toLocaleString()} bytes. The server checks both snapshots again before removal.</p><p>Reviewed against workspace revision {removal.targetRevision}.</p>{retained.some(row=>row.id===removal.backup.id&&row.chargedParts>0)&&<p role="alert">Clean up the redundant retained generation before removing this logical recovery point.</p>}{removal.targetRevision !== targetRevision && <p role="alert">Your workspace changed after this review. Refresh recovery history and review the snapshot again.</p>}<label className="check-card"><input type="checkbox" checked={confirmed} disabled={disabled || removal.targetRevision !== targetRevision} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed this snapshot and the newer recovery point. Permanently remove this selected snapshot.</span></label><div className="data-actions"><button type="button" className="button secondary" disabled={disabled} onClick={() => { setRemoval(null); setConfirmed(false); }}>Keep snapshot</button><button type="button" className="button primary" disabled={disabled || !onBackupRemove || !confirmed || removal.targetRevision !== targetRevision || retained.some(row=>row.id===removal.backup.id&&row.chargedParts>0)} onClick={() => void removeSnapshot()}>{working === 'remove' ? 'Removing snapshot…' : 'Permanently remove reviewed snapshot'}</button></div>{!onBackupRemove && <p className="field-hint">Snapshot removal is unavailable in this session.</p>}</div>}
    <section className="restore-preview" aria-label="Retained generation cleanup"><h3>Redundant retained generations</h3><p>Recovery may keep an older physical generation while the same logical snapshot uses a separately verified new generation. These old files remain charged. Review one generation at a time before cleanup; the server must verify the complete current native archive independently. No files are deleted automatically.</p><div className="data-actions"><button type="button" className="button secondary" disabled={disabled} onClick={()=>void retainedPageAction()}>Refresh retained generations</button><button type="button" className="button secondary" disabled={disabled||!retainedNext} onClick={()=>void retainedPageAction(retainedNext??undefined)}>Next retained generations</button></div>{retainedError&&<p role="alert">{retainedError}</p>}{!retainedError&&retained.length===0&&<p>No redundant retained generations are listed.</p>}{retained.map(row=><article className="capture-preview" key={row.id+':'+row.generationHash}><h4>Redundant generation for recovery snapshot {row.id}</h4><p>{row.files} files · {row.archiveBytes.toLocaleString()} original ZIP bytes · {row.chargedBytes.toLocaleString()} bytes remain charged across {row.chargedParts} old parts.</p><p>Pending cleanup records: {row.pendingCleanupCount}</p><p className="field-hint">Bookkeeping only; the displayed summary is not fresh proof that the current archive is available.</p><button type="button" className="button secondary" disabled={disabled} onClick={()=>{setRetainedReview(row);setRetainedConfirmed(false);setCleanup(null);setCleanupConfirmed(false);setError('');setMessage('');}}>Review redundant generation cleanup</button></article>)}</section>
    {retainedReview&&<div className="restore-preview" aria-label="Review redundant generation cleanup"><h3>Review redundant generation cleanup</h3><p>This requests physical cleanup of only the exact old generation reviewed here. The current ready generation and its logical snapshot are retained. The server rechecks the complete current ZIP, index and physical ledger before any old-key deletion. Failure or an uncertain result does not authorize another generation or release unconfirmed charges.</p><dl><dt>Snapshot</dt><dd>{retainedReview.id}</dd><dt>Bytes still charged at review</dt><dd>{retainedReview.chargedBytes.toLocaleString()}</dd><dt>Old parts</dt><dd>{retainedReview.chargedParts}</dd><dt>Current archive index SHA-256</dt><dd style={{overflowWrap:'anywhere'}}>{retainedReview.indexHash}</dd><dt>Reviewed redundant generation SHA-256</dt><dd style={{overflowWrap:'anywhere'}}>{retainedReview.generationHash}</dd></dl><label className="check-card"><input type="checkbox" checked={retainedConfirmed} disabled={disabled} onChange={event=>setRetainedConfirmed(event.target.checked)}/><span>I reviewed this exact redundant generation and request cleanup while retaining the current recovery point.</span></label><div className="data-actions"><button type="button" className="button secondary" disabled={disabled} onClick={()=>{setRetainedReview(null);setRetainedConfirmed(false);}}>Keep redundant generation</button><button type="button" className="button primary" disabled={disabled||!retainedConfirmed} onClick={()=>void cleanupRetainedFiles()}>{working==='retained-cleanup'?'Checking redundant cleanup…':'Clean up reviewed redundant generation'}</button></div><p className="field-hint">After confirmation, refresh may show another old generation. It requires a new separate review and consent.</p></div>}
    <section className="restore-preview" aria-label="Retired file archive cleanup"><h3>Retired file archives</h3><p>Logical removal does not delete physical files. These dated records show retained charges and uncertain operations. Cleanup is a separate owner action; current recovery points are never selected here.</p><div className="data-actions"><button type="button" className="button secondary" disabled={disabled} onClick={()=>void retiredPageAction()}>Refresh retired file archives</button><button type="button" className="button secondary" disabled={disabled||!retiredNext} onClick={()=>void retiredPageAction(retiredNext??undefined)}>Next retired archives</button></div>{retiredError&&<p role="alert">{retiredError}</p>}{!retiredError&&retired.length===0&&<p>No retired file archives are listed.</p>}{retired.map(row=><article className="capture-preview" key={row.id}><h4>Retired {dateLabel(row.retiredAt,true)}</h4><p>{row.files} files · {row.archiveBytes.toLocaleString()} original ZIP bytes · {row.chargedBytes.toLocaleString()} bytes remain charged across {row.chargedParts} parts.</p><p>Unconfirmed uploads: {row.pendingUploadCount} · Pending cleanup records: {row.pendingCleanupCount}</p><p className="field-hint">Saved bookkeeping only; this is not a fresh storage availability or physical-deletion claim.</p><button type="button" className="button secondary" disabled={disabled||row.chargedParts===0||row.pendingUploadCount>0||!row.cleanupAuthorized} onClick={()=>{setRetainedReview(null);setRetainedConfirmed(false);setCleanup(row);setCleanupConfirmed(false);setError('');setMessage('');}}>Review retired file cleanup</button>{!row.cleanupAuthorized&&<p role="status">This historical retirement has no current cleanup authorization. No physical deletion is permitted.</p>}{!row.cleanupAuthorized&&<button type="button" className="button secondary" disabled={disabled||row.chargedParts===0||row.pendingUploadCount>0} onClick={()=>{setReauthorization(row);setReauthorizationCandidate('');setReauthorizationConfirmed(false);setCleanup(null);setCleanupConfirmed(false);setRetainedReview(null);setRetainedConfirmed(false);setRemoval(null);setConfirmed(false);setError('');setMessage('');}}>Review renewed cleanup authorization</button>}{row.pendingUploadCount>0&&<p role="status">Cleanup is blocked while an upload outcome remains unconfirmed.</p>}</article>)}</section>
    {reauthorization&&<div className="restore-preview" aria-label="Review renewed cleanup authorization"><h3>Review renewed cleanup authorization</h3><p>This historical retirement needs fresh authorization. Select a current complete native file recovery point. The server must verify it is strictly newer than the retired archive, read and verify its complete ZIP and physical file ledger, and recheck current authority. A metadata JSON bundle or private import alone cannot authorize deletion.</p><dl><dt>Retired</dt><dd>{reauthorization.retiredAt}</dd><dt>Bytes still charged</dt><dd>{reauthorization.chargedBytes.toLocaleString()}</dd><dt>Retired index SHA-256</dt><dd style={{overflowWrap:'anywhere'}}>{reauthorization.indexHash}</dd></dl><label className="field"><span className="field-label">Newer complete native file recovery point</span><select value={reauthorizationCandidate} disabled={disabled} onChange={event=>{setReauthorizationCandidate(event.target.value);setReauthorizationConfirmed(false);}}><option value="">Choose a recovery point</option>{reauthorizationCandidates.filter(row=>row.id!==reauthorization.id).map(row=><option key={row.id} value={row.id}>{row.createdAt} · Revision {row.sourceRevision} · {row.id}</option>)}</select></label>{!reauthorizationCandidates.length&&<p role="status">No ready native file recovery point is listed. Create and verify a newer complete file archive first.</p>}<p className="field-hint">Listed status is dated bookkeeping, not fresh proof. Renewal may be refused if the selected point is older, unavailable, incomplete or changed.</p><RetiredAuthorizationConsent confirmed={reauthorizationConfirmed} disabled={disabled} onChange={setReauthorizationConfirmed}/><div className="data-actions"><button type="button" className="button secondary" disabled={disabled} onClick={()=>{setReauthorization(null);setReauthorizationConfirmed(false);setReauthorizationCandidate('');}}>Keep files without renewed authorization</button><button type="button" className="button primary" disabled={disabled||!reauthorizationConfirmed||!reauthorizationCandidate||reauthorization.pendingUploadCount>0} onClick={()=>void reauthorize()}>{working==='reauthorize'?'Verifying newer file recovery…':'Renew authorization without deleting files'}</button></div><p className="field-hint">A successful renewal does not run cleanup. Physical deletion requires a new, separate review and unchecked consent.</p></div>}
    {cleanup&&<div className="restore-preview" aria-label="Review physical archive cleanup"><h3>Review physical archive cleanup</h3><p>This explicitly attempts deletion of only the retired archive chunks listed below. The logical snapshot is already removed. Current recovery snapshots and attachment files are retained. Unknown storage outcomes keep their permanent identity and charge until absence is confirmed.</p><dl><dt>Retired</dt><dd>{cleanup.retiredAt}</dd><dt>Bytes still charged at review</dt><dd>{cleanup.chargedBytes.toLocaleString()}</dd><dt>Parts</dt><dd>{cleanup.chargedParts}</dd><dt>Archive index SHA-256</dt><dd style={{overflowWrap:'anywhere'}}>{cleanup.indexHash}</dd></dl><label className="check-card"><input type="checkbox" checked={cleanupConfirmed} disabled={disabled} onChange={event=>setCleanupConfirmed(event.target.checked)}/><span>I reviewed this retired archive and request physical cleanup of its retained chunks.</span></label><div className="data-actions"><button type="button" className="button secondary" disabled={disabled} onClick={()=>{setCleanup(null);setCleanupConfirmed(false);}}>Keep retired files</button><button type="button" className="button primary" disabled={disabled||!cleanupConfirmed||cleanup.pendingUploadCount>0||!cleanup.cleanupAuthorized} onClick={()=>void cleanupFiles()}>{working==='cleanup'?'Checking cleanup outcome…':'Clean up reviewed retired files'}</button></div></div>}
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="restore-message" role="status">{message}</p>}
  </section>;
}
