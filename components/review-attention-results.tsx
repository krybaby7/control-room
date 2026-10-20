'use client';
import {useContext,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import type {Workspace} from '@/lib/types';
import type {ReviewAttentionItem} from '@/lib/review-attention';
import {evidenceSubjectSchema,evidenceDateSchema} from '@/lib/evidence-validation';
import {entityHref,parseEntityLink} from '@/lib/entity-links';
import {parseReviewLink,reviewHref} from '@/lib/review-links';
import {boundedRequest} from '@/lib/save-controller';
import {SessionExpiredError} from '@/lib/workspace-client';
import {SessionExpiredContext} from './session-state';
const category=z.enum(['missing-evidence','assessment-review','decision-review']);
const itemSchema=z.object({id:z.string().min(1).max(300),kind:category,subject:evidenceSubjectSchema.optional(),projectId:z.string().min(1).max(128).nullable(),title:z.string().min(1).max(1000),reasons:z.array(z.string().max(20_000)).max(10000),href:z.string().max(4096)}).strict();
function localHref(href:string,workspace:Workspace):string{
 if(!href.startsWith('/?')||href.includes('#')||href.startsWith('//'))throw new Error('Invalid attention citation.');
 const review=parseReviewLink(href);if(review.status==='valid')return reviewHref(review.target);
 if(href==='/?view=evidence')return href;
 const entity=parseEntityLink(href,workspace);if(entity.status==='available'){
  const expected=entityHref(entity.target);if(new URLSearchParams(href.slice(2)).toString()!==new URLSearchParams(expected.slice(2)).toString())throw new Error('Invalid attention citation.');return expected;
 }
 throw new Error('Invalid attention citation.');
}
async function readAttention(response:Response,revision:number,workspace:Workspace):Promise<{revision:number;asOf:string;items:ReviewAttentionItem[]}>{
 if(!response.ok)throw new Error('Review attention is unavailable.');const reader=response.body?.getReader();if(!reader)throw new Error('Review attention is incomplete.');const chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>8_000_000){void reader.cancel().catch(()=>{});throw new Error('Review attention exceeds its read limit.');}chunks.push(item.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const value=z.object({revision:z.number().int().positive().safe(),asOf:evidenceDateSchema,items:z.array(itemSchema).max(10000)}).strict().parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 if(value.revision!==revision)throw new Error('The saved revision changed. Refresh the workspace to review attention.');const ids=new Set<string>();for(const item of value.items){if(ids.has(item.id))throw new Error('Review attention contains ambiguous records.');ids.add(item.id);item.href=localHref(item.href,workspace);if(item.projectId!==null&&!workspace.projects.some(project=>project.id===item.projectId))throw new Error('Review attention project is unavailable.');}return value;
}
export function ReviewAttentionResults({workspace,revision}:{workspace:Workspace;revision:number}){
 const contextExpired=useContext(SessionExpiredContext),[expired,setExpired]=useState(false),[kind,setKind]=useState<''|ReviewAttentionItem['kind']>(''),[projectId,setProjectId]=useState('');const [loaded,setLoaded]=useState<{revision:number;asOf:string;items:ReviewAttentionItem[];error:string}|null>(null);const generation=useRef(0),active=useRef<AbortController|null>(null);
 const key=JSON.stringify({revision,kind,projectId});const [paging,setPaging]=useState({key:'',page:1});const selected=paging.key===key?paging.page:1;
 useEffect(()=>{const clear=()=>{generation.current++;active.current?.abort();setExpired(true);setLoaded(null);setKind('');setProjectId('');};window.addEventListener('control-room-session-expired',clear);return()=>window.removeEventListener('control-room-session-expired',clear);},[]);
 useEffect(()=>{if(expired||contextExpired)return;const epoch=++generation.current,controller=new AbortController();active.current=controller;let remove=()=>{};
  void boundedRequest('/api/evidence/attention',{credentials:'same-origin',cache:'no-store'},response=>readAttention(response,revision,workspace),{deadlineMs:15000,fetch:(input,init)=>{const signal=init?.signal,abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});remove=()=>signal?.removeEventListener('abort',abort);return fetch(input,{...init,signal:controller.signal});}}).then(value=>{if(generation.current===epoch&&!controller.signal.aborted)setLoaded({...value,error:''});}).catch(error=>{if(generation.current!==epoch||controller.signal.aborted)return;if(error instanceof SessionExpiredError){window.dispatchEvent(new Event('control-room-session-expired'));return;}setLoaded({revision,asOf:'',items:[],error:error instanceof Error&&error.message.startsWith('The saved revision changed.')?error.message:'Review attention could not be loaded safely. Refresh the workspace and try again.'});}).finally(()=>remove());
  return()=>{if(generation.current===epoch)generation.current=epoch+1;controller.abort();remove();};
 },[revision,workspace,expired,contextExpired]);
 if(expired||contextExpired)return <section aria-label="Evidence and decision attention"><p role="alert">Sign in again to view private review attention.</p></section>;
 const current=loaded?.revision===revision?loaded:null,items=current?.items.filter(item=>(!kind||item.kind===kind)&&(!projectId||item.projectId===projectId))??[],pages=Math.ceil(items.length/50),page=Math.min(selected,Math.max(1,pages));
 return <section className="panel data-panel" aria-label="Evidence and decision attention"><h2>Evidence and decision attention</h2><p>This is a read-only review of recorded claims and metadata. File verification is not performed by this metadata-only attention view. Reasons describe historical context and server assessment limits; they do not accept, complete or execute work.</p><div className="form-grid"><label className="field"><span>Review attention category</span><select aria-label="Review attention category" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="">All review attention categories</option><option value="missing-evidence">Missing evidence</option><option value="assessment-review">Assessment review</option><option value="decision-review">Decision review</option></select></label><label className="field"><span>Review attention project</span><select aria-label="Review attention project" value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">All projects</option>{workspace.projects.map(project=><option key={project.id} value={project.id}>{project.name} · {project.id}{project.archivedAt?' (archived)':''}</option>)}</select></label></div>
 {!current?<p role="status">Loading owner-scoped review attention…</p>:current.error?<p role="alert">{current.error}</p>:<><p>Reviewed as of {current.asOf} · Saved revision {current.revision} · {items.length} matching items of {current.items.length} total · Showing {items.length?(page-1)*50+1:0}–{Math.min(page*50,items.length)}</p>{!items.length&&<p>No review attention items match these filters.</p>}{items.slice((page-1)*50,page*50).map(item=><article className="capture-preview" key={item.id}><h3><a href={item.href}>{item.title}</a></h3><p>{item.kind} · {item.id}</p>{item.subject&&<p>Subject: {item.subject.type} · {item.subject.id}</p>}<ul>{item.reasons.map((reason,index)=><li key={index} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{reason}</li>)}</ul></article>)}<nav aria-label="Review attention result pages"><button type="button" className="button secondary" disabled={page<=1} onClick={()=>setPaging({key,page:page-1})}>Previous 50 review attention items</button><span>Page {items.length?page:0} of {pages}</span><button type="button" className="button secondary" disabled={page>=pages} onClick={()=>setPaging({key,page:page+1})}>Next 50 review attention items</button></nav></>}
 </section>;
}
