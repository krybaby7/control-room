import {z} from 'zod';
import type {BackupManifest} from './workspace-backups.ts';
import type {BackupStorage} from './backup-storage.ts';
import {canonical,contentHash,parseWorkspaceBundle,type WorkspaceBundle} from './workspace-export.ts';
export interface BackupCapabilities {renewableAuthenticatedScopedRunner:boolean;verifiedCompletePrivateObjectStorage:boolean;}
const stamp=z.string().datetime({offset:true});
const policySchema=z.object({enabled:z.boolean().default(false),timezone:z.literal('Africa/Cairo').default('Africa/Cairo'),dailyLocalTime:z.literal('03:00').default('03:00'),weeklyDay:z.literal('Monday').default('Monday'),retentionDaily:z.literal(14).default(14),retentionWeekly:z.literal(8).default(8),lastSuccessAt:stamp.nullable().default(null),lastFailureCode:z.string().regex(/^[a-z0-9-]{1,80}$/).nullable().default(null),nextDueAt:stamp.nullable().default(null)}).strict();
export type BackupPolicy=z.infer<typeof policySchema>;
export function createBackupPolicy(input:unknown,capabilities:BackupCapabilities):BackupPolicy {
 const policy=policySchema.parse(input);
 if(policy.enabled && (!capabilities.renewableAuthenticatedScopedRunner || !capabilities.verifiedCompletePrivateObjectStorage))throw new Error('Scheduled backup activation requires a renewable scoped runner and verified complete private object storage.');
 return {...policy,nextDueAt:policy.enabled?policy.nextDueAt:null};
}
const cairo=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'long'});
function localParts(ms:number):Record<string,string>{return Object.fromEntries(cairo.formatToParts(new Date(ms)).map(part=>[part.type,part.value]));}
/** Strictly next local 03:00, using runtime IANA timezone transitions, including midnight DST changes. */
export function nextBackupDue(now:string,policy:BackupPolicy):string|null {
 const parsed=policySchema.parse(policy),instant=Date.parse(now);if(!Number.isFinite(instant))throw new Error('Invalid schedule clock.');if(!parsed.enabled)return null;
 for(let ms=Math.floor(instant/60_000)*60_000+60_000,end=instant+172_800_000;ms<=end;ms+=60_000){const parts=localParts(ms);if(parts.hour==='03'&&parts.minute==='00')return new Date(ms).toISOString();}
 throw new Error('Next Cairo backup occurrence could not be resolved.');
}
export interface BackupServicePrincipal {registered:true;ownerId:string;scopes:readonly string[];renewable:true;}
interface JobIdentity {userId:string;scheduledFor:string;jobId:string;dedupeKey:string;}
export type BackupClaim={status:'ready';manifest:BackupManifest}|{status:'busy'}|{status:'claimed';claimToken:string;preparing?:BackupManifest};
/** Adapter to the shared admitted job-intent/lease substrate, never an independently populated queue. */
export interface BackupJobStore {
 /** CAS only an existing policy-admitted intent for this owner/time; enforce lease, epoch and principal scope. */
 claimExisting(identity:JobIdentity):Promise<BackupClaim>;
 stage(claimToken:string,manifest:BackupManifest):Promise<boolean>;
 /** Atomically assert claim, owner source revision, quota and enabled policy; insert manifest + success + nextDue. */
 commitReady(input:{claimToken:string;manifest:BackupManifest;expectedRevision:number;lastSuccessAt:string;nextDueAt:string|null}):Promise<boolean>;
 /** CAS failure state/backoff only while this attempt owns the lease. Preserve immutable preparing object references. */
 fail(claimToken:string,code:string,failedAt:string):Promise<void>;
}
export interface BackupJobDeps {
 now:()=>string;policy:BackupPolicy;capabilities:BackupCapabilities;storage:BackupStorage;jobs:BackupJobStore;
 /** Resolve an authenticated registered service principal from actual runner context, not input owner fields. */
 resolvePrincipal:()=>Promise<BackupServicePrincipal|null>;
 /** Must use the consistent owner-scoped export registry snapshot implementation. */
 exportBundle:(userId:string)=>Promise<WorkspaceBundle>;
}
function validManifest(manifest:BackupManifest,owner:string):void {
 if(!Number.isFinite(Date.parse(manifest.createdAt))||manifest.ownerScope!==owner||manifest.storageKind!=='r2'||manifest.missingAttachments.length||!manifest.completeModules.includes('planning')||!Number.isSafeInteger(manifest.sourceRevision)||manifest.sourceRevision<1||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||manifest.bytes>8_000_000||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw new Error('Invalid scheduled recovery manifest.');
}
async function verifiedObject(storage:BackupStorage,manifest:BackupManifest):Promise<Uint8Array|null>{const bytes=await storage.get(manifest.storageKey);if(!bytes)return null;if(bytes.byteLength!==manifest.bytes||await contentHash(bytes)!==manifest.sha256)throw new Error('Backup object digest mismatch.');return bytes;}
function bundleFor(bytes:Uint8Array,manifest:BackupManifest):WorkspaceBundle {
 const bundle=parseWorkspaceBundle(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 if(bundle.source.workspaceRevision!==manifest.sourceRevision || bundle.attachments.length || canonical(['planning',...Object.keys(bundle.modules).sort()])!==canonical(manifest.completeModules))throw new Error('Backup object recovery metadata mismatch.');return bundle;
}
export async function runBackupJob(input:{userId:string;scheduledFor:string;jobId:string},deps:BackupJobDeps):Promise<{status:'ready'|'replayed';manifest:BackupManifest}|{status:'busy'|'disabled'}> {
 const policy=createBackupPolicy(deps.policy,deps.capabilities);if(!policy.enabled)return {status:'disabled'};
 if(!deps.storage.available)throw new Error('Private backup storage is unavailable.');
 const principal=await deps.resolvePrincipal();
 if(!principal?.registered||!principal.renewable||principal.ownerId!==input.userId||!principal.scopes.includes('backups:write'))throw new Error('Registered owner-scoped backup service identity is required.');
 const scheduled=Date.parse(input.scheduledFor),now=deps.now(),clock=Date.parse(now);
 if(!input.userId||!/^[A-Za-z0-9_-]{1,128}$/.test(input.jobId)||!Number.isFinite(scheduled)||!Number.isFinite(clock)||scheduled>clock||new Date(scheduled).toISOString()!==input.scheduledFor||localParts(scheduled).hour!=='03'||localParts(scheduled).minute!=='00'||scheduled%60_000!==0)throw new Error('Invalid admitted backup occurrence.');
 const dedupeKey=await contentHash(canonical([input.userId,input.scheduledFor]));const claim=await deps.jobs.claimExisting({...input,dedupeKey});
 if(claim.status==='busy')return {status:'busy'};
 if(claim.status==='ready'){validManifest(claim.manifest,input.userId);if(claim.manifest.status!=='ready')throw new Error('Stored backup result is not ready.');const bytes=await verifiedObject(deps.storage,claim.manifest);if(!bytes)throw new Error('Stored backup object is missing.');bundleFor(bytes,claim.manifest);return {status:'replayed',manifest:structuredClone(claim.manifest)};}
 try {
  let manifest=claim.preparing;
  if(manifest){validManifest(manifest,input.userId);if(manifest.status!=='preparing')throw new Error('Invalid preparing backup state.');}
  let bytes=manifest?await verifiedObject(deps.storage,manifest):null;
  if(bytes&&manifest)bundleFor(bytes,manifest);
  if(!bytes){
   const bundle=parseWorkspaceBundle(await deps.exportBundle(input.userId));if(bundle.attachments.length)throw new Error('Complete attachment object backup is unavailable.');
   bytes=new TextEncoder().encode(JSON.stringify(bundle));const sha256=await contentHash(bytes);
   if(bundle.source.planningSchemaVersion!==bundle.planning.schemaVersion)throw new Error('Backup exporter must provide the current planning schema.');
   if(manifest && (manifest.sha256!==sha256||manifest.bytes!==bytes.byteLength||manifest.sourceRevision!==bundle.source.workspaceRevision))throw new Error('Preparing backup source changed; reconcile before retry.');
   if(!manifest){const id=crypto.randomUUID();manifest={id,ownerScope:input.userId,sourceRevision:bundle.source.workspaceRevision,reason:'scheduled',createdAt:now,formatVersion:1,bytes:bytes.byteLength,sha256,storageKind:'r2',storageKey:`backups/${await contentHash(input.userId)}/${id}`,status:'preparing',expiresAt:null,completeModules:['planning',...Object.keys(bundle.modules).sort()],missingAttachments:[]};validManifest(manifest,input.userId);if(!await deps.jobs.stage(claim.claimToken,manifest))throw new Error('Backup staging lease changed.');}
   await deps.storage.put(manifest.storageKey,bytes,manifest.sha256);
  }
  if(!manifest)throw new Error('Backup preparation is missing.');const confirmed=await verifiedObject(deps.storage,manifest);if(!confirmed)throw new Error('Backup object missing after write.');bundleFor(confirmed,manifest);
  const ready={...manifest,status:'ready' as const};if(!await deps.jobs.commitReady({claimToken:claim.claimToken,manifest:ready,expectedRevision:manifest.sourceRevision,lastSuccessAt:now,nextDueAt:nextBackupDue(now,policy)}))throw new Error('Backup commit revision, quota or lease conflict.');
  return {status:'ready',manifest:ready};
 }catch(error){await deps.jobs.fail(claim.claimToken,'backup-attempt-failed',now);throw error;}
}
export interface VerifiedRecoveryPoint {manifest:BackupManifest;verifiedBytes:true;pinned:boolean;}
/** Pure candidates only. Caller must reverify and atomically protect newer recovery points before deleting. */
export function retentionPlan(points:readonly VerifiedRecoveryPoint[],newReady:VerifiedRecoveryPoint):string[] {
 const newest=newReady.manifest;validManifest(newest,newest.ownerScope);if(newReady.verifiedBytes!==true||newest.status!=='ready')throw new Error('Retention requires a new verified ready backup.');
 const source=points.some(point=>point.manifest.id===newest.id)?points:[...points,newReady];
 if(new Set(source.map(point=>point.manifest.id)).size!==source.length)throw new Error('Duplicate retention identity.');
 const eligible=source.filter(point=>point.verifiedBytes===true && point.manifest.ownerScope===newest.ownerScope && point.manifest.status==='ready' && point.manifest.reason==='scheduled' && !point.pinned && !point.manifest.missingAttachments.length).sort((a,b)=>Date.parse(b.manifest.createdAt)-Date.parse(a.manifest.createdAt));
 const daily=new Set<string>(),weekly=new Set<string>(),keep=new Set<string>([newest.id]);
 for(const point of eligible){const parts=localParts(Date.parse(point.manifest.createdAt));const date=`${parts.year}-${parts.month}-${parts.day}`;if(daily.size<14&&!daily.has(date)){daily.add(date);keep.add(point.manifest.id);}if(parts.weekday==='Monday'&&weekly.size<8&&!weekly.has(date)){weekly.add(date);keep.add(point.manifest.id);}}
 return eligible.filter(({manifest})=>!keep.has(manifest.id)&&(newest.sourceRevision>manifest.sourceRevision||newest.sourceRevision===manifest.sourceRevision&&Date.parse(newest.createdAt)>Date.parse(manifest.createdAt))).map(point=>point.manifest.id);
}
