import {dirname,join,isAbsolute} from 'node:path';
import {createCredentialStore} from './credentials.mjs';
import {SITE_PROJECT_ID,SITE_ORIGIN} from './site-identity.mjs';
import {cloudOrigin,unavailablePrivateIngress,BridgeTransportError} from './transport.mjs';
import {exactObject,timestamp} from './config.mjs';
export const MANUAL_SITES_WINDOW_MS=15*60*1000;
const post=new Set(['/api/bridge/enroll','/api/bridge/session','/api/bridge/live-window','/api/bridge/heartbeat','/api/bridge/rotate','/api/bridge/evaluations',...['capabilities','claim','renew','events','complete','reconcile'].map(action=>'/api/bridge/jobs/'+action),...['mutation-id','reserve','finalize'].map(action=>'/api/bridge/jobs/artifacts/'+action)]);
const content=/^\/api\/bridge\/jobs\/artifacts\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/content$/u;
const unavailable=()=>{throw new BridgeTransportError('private_ingress_unavailable');};
function time(value){try{return Date.parse(timestamp(value));}catch{unavailable();}}
function parse(record,origin,at){try{exactObject(record,['schemaVersion','mode','projectId','siteOrigin','createdAt','releaseUntil','bearer']);}catch{unavailable();}
 if(record.schemaVersion!==1||record.mode!=='manual-owner-private-sites'||record.projectId!==SITE_PROJECT_ID||record.siteOrigin!==SITE_ORIGIN||cloudOrigin(origin)!==SITE_ORIGIN||origin!==SITE_ORIGIN||typeof record.bearer!=='string'||record.bearer.length<16||record.bearer.length>8192||!/^[A-Za-z0-9._~+/-]+=*$/u.test(record.bearer))unavailable();
 const start=time(record.createdAt),until=time(record.releaseUntil);if(!Number.isFinite(at)||start>at||until<=at||until-start>MANUAL_SITES_WINDOW_MS||until<=start)unavailable();return {start,until};
}
export function manualSitesCredentialPath(configPath){if(typeof configPath!=='string'||!isAbsolute(configPath)||/[\r\n\0]/u.test(configPath))unavailable();return join(dirname(configPath),'.control-room-bridge','sites-access.dpapi');}
/** A local release cutoff, NOT a claim about issuer token expiry or renewal. No
 * request gains visitor identity, app consent or device authority from this. */
export function createManualSitesAccessAdapter({record,origin,now=()=>Date.now(),monotonic=()=>performance.now(),remove=async()=>{}}){
 const selected={...record},initial=now(),window=parse(selected,origin,initial),baseline=monotonic(),deadline=baseline+window.until-initial;if(!Number.isFinite(baseline))unavailable();let last=initial,stopped=false;
 function assertAvailable(){const at=now(),elapsed=monotonic();if(stopped||!Number.isFinite(at)||!Number.isFinite(elapsed)||elapsed<baseline||at<last||at>=window.until||elapsed>=deadline)unavailable();last=at;}
 return Object.freeze({mode:'manual-owner-private-sites',releaseUntil:selected.releaseUntil,issuerExpiryVerified:false,renewable:false,assertAvailable,
 async getHeaders(context){assertAvailable();if(context?.signal?.aborted)unavailable();
  let url;try{url=new URL(context.url);}catch{unavailable();}const path=url.pathname;
  if(url.origin!==SITE_ORIGIN||context.url!==SITE_ORIGIN+path||url.search||url.hash||context.path!==path||!(context.method==='POST'&&post.has(path)||context.method==='PUT'&&content.test(path)))unavailable();
  return {headers:{'OAI-Sites-Authorization':'Bearer '+selected.bearer},expiresAt:selected.releaseUntil};
 },async invalidate(){if(stopped)return;stopped=true;await remove();}});
}
/** Called only after the fixed private-state guard protects this config/tree. */
export async function resolveManualSitesAccess({configPath,origin}){if(origin!==SITE_ORIGIN||process.platform!=='win32')return unavailablePrivateIngress;const store=createCredentialStore({path:manualSitesCredentialPath(configPath)});try{const record=await store.load();if(record===null)return unavailablePrivateIngress;return createManualSitesAccessAdapter({record,origin,remove:()=>store.remove()});}catch{return unavailablePrivateIngress;}}
export async function saveManualSitesAccess({configPath,origin,releaseUntil,bearer,ownerPrivateConfirmed,now=()=>Date.now(),store}){if(ownerPrivateConfirmed!==true)unavailable();const createdAt=new Date(now()).toISOString(),record={schemaVersion:1,mode:'manual-owner-private-sites',projectId:SITE_PROJECT_ID,siteOrigin:origin,createdAt,releaseUntil,bearer};parse(record,origin,now());await(store??createCredentialStore({path:manualSitesCredentialPath(configPath)})).save(record);return {status:'manual_access_protected',releaseUntil,issuerExpiryVerified:false,renewable:false};}
export async function removeManualSitesAccess({configPath}){await createCredentialStore({path:manualSitesCredentialPath(configPath)}).remove();return {status:'manual_access_removed'};}
