import {evidenceDateSchema} from '../evidence-validation.ts';
import type {PrivateIngressVerifier,PrivateIngressVerdict} from './contracts.ts';

/** Deployment metadata, never caller identity or a renewable service credential. */
export const MANUAL_SITES_PROJECT='appgprj_6ad38014b404819182d7d59170f460a7';
export const MANUAL_SITES_ORIGIN='https://adami-project-control-center.roundmoth32.chatgpt.site';
export interface ManualSitesWindow {mode:'manual-owner-private-sites';projectId:string;siteOrigin:string;confirmedAt:string;releaseUntil:string}
export interface ManualSitesVerdict {readonly kind:'manual-owner-private-sites'}
const verdicts=new WeakMap<object,{key:string;expires:number;issued:number}>();
const posts=new Set(['enroll','session','live-window','heartbeat','rotate','evaluations','jobs/capabilities','jobs/claim','jobs/renew','jobs/events','jobs/complete','jobs/reconcile','jobs/artifacts/mutation-id','jobs/artifacts/reserve','jobs/artifacts/finalize'].map(path=>'/api/bridge/'+path));
export function parseManualSitesWindow(raw:unknown,now:string):ManualSitesWindow|null{
 try{
  if(typeof raw!=='string'||raw.length>2048||!evidenceDateSchema.safeParse(now).success)return null;
  const value=JSON.parse(raw) as ManualSitesWindow;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='confirmedAt,mode,projectId,releaseUntil,siteOrigin'||value.mode!=='manual-owner-private-sites'||value.projectId!==MANUAL_SITES_PROJECT||value.siteOrigin!==MANUAL_SITES_ORIGIN||!evidenceDateSchema.safeParse(value.confirmedAt).success||!evidenceDateSchema.safeParse(value.releaseUntil).success)return null;
  const start=Date.parse(value.confirmedAt),end=Date.parse(value.releaseUntil),current=Date.parse(now);
  return start<=current&&current<end&&end>start&&end-start<=15*60000?Object.freeze(value):null;
 }catch{return null;}
}
/** Only an operator-confirmed owner-private native Sites deployment may enable
 * this finite window. Dispatch consumes its bearer before invoking the Worker;
 * neither a retained bearer nor visitor/caller headers prove this boundary.
 * Direct Worker/public deployment is unsupported and must remain unconfigured.
 */
export function createManualSitesIngress(raw:unknown,now:()=>string=()=>new Date().toISOString()):PrivateIngressVerifier{
 return {async verify(request){
  const at=now(),window=parseManualSitesWindow(raw,at);if(!window)return null;
  const url=new URL(request.url);
  if(url.origin!==window.siteOrigin||url.search||url.hash||request.headers.has('cookie')||request.headers.has('x-control-room-ingress-verdict')||request.headers.has('x-control-room-service-identity'))return null;
  if(!(request.method==='POST'&&posts.has(url.pathname)||request.method==='PUT'&&/^\/api\/bridge\/jobs\/artifacts\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/content$/.test(url.pathname)))return null;
  const verdict=Object.freeze({kind:'manual-owner-private-sites' as const});
  verdicts.set(verdict,{key:'manual-sites:'+window.projectId+':'+window.confirmedAt,issued:Date.parse(window.confirmedAt),expires:Date.parse(window.releaseUntil)});return verdict;
 }};
}
/** Legacy service identities are retained only for existing server adapters and
 * synthetic fixtures. Production manual Sites factories never construct one. */
export function privateIngressBoundaryKey(value:PrivateIngressVerdict|null,now:string):string|null{
 if(!value||typeof value!=='object')return null;
 const record=verdicts.get(value);
 if(record)return evidenceDateSchema.safeParse(now).success&&record.issued<=Date.parse(now)&&Date.parse(now)<record.expires?record.key:null;
 return 'serviceIdentity'in value&&typeof value.serviceIdentity==='string'&&value.serviceIdentity.length>0&&value.serviceIdentity.length<=256?value.serviceIdentity:null;
}
