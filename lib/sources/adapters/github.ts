import { z } from 'zod';
import { canonical, contentHash } from '../../canonical-json.ts';
import { evidenceDateSchema } from '../../evidence-validation.ts';
import { SOURCE_LIMITS, SourceReadError, type SourceAdapter, type SourceCursor, type SourceObservation, type AccessMode } from '../contracts.ts';
import { sourceCursorSchema, sourceTargetSchema, sourcePageSchema } from '../validation.ts';
import type { JsonValue } from '../../workspace-protocol.ts';

export type GithubReadRequest = { repositoryId: string; ifNoneMatch: string | null } & (
  | { operation: 'repository' }
  | { operation: 'branch'; branch: string }
  | { operation: 'file'; commitSha: string; path: string }
  | { operation: 'pulls'; continuation: string | null; pageSize: number; state: 'all'; sort: 'created'; direction: 'asc' }
  | { operation: 'checks'; headSha: string; continuation: string | null; pageSize: number; filter: 'all' }
);
/** Server-injected read-only transport. It must map closed operations to GitHub,
 * enforce maxBytes while fetching, encode branch/path components, and keep
 * credentials outside this adapter. Continuations are validated before dispatch. */
export interface GithubReadTransport {
  read(request: GithubReadRequest, context: { signal: AbortSignal; maxBytes: number }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array | ReadableStream<Uint8Array> }>;
}
export interface GithubAdapterOptions {
  mode?: AccessMode;
  pageSize?: number;
  transport?: GithubReadTransport;
  /** Server-verified, owner-bound configuration, never browser/authoring metadata. */
  verification?: { connectionId: string; resourceIds: string[]; interactiveAt: string | null; unattendedAt: string | null };
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const providerId = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9][0-9]{0,19}$/)]).transform(String);
const stamp = evidenceDateSchema.nullable();
const repoSchema = z.object({ id: providerId, full_name: z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), html_url: z.string().max(4000), default_branch: z.string().min(1).max(255), updated_at: stamp });
const branchSchema = z.object({ name: z.string(), commit: z.object({ sha }) });
const fileSchema = z.object({ type: z.literal('file'), path: z.string(), sha, size: z.number().int().nonnegative().max(SOURCE_LIMITS.pageBytes), encoding: z.enum(['base64','utf-8']), content: z.string(), html_url: z.string().max(4000) });
const pullSchema = z.object({ id: providerId, number: z.number().int().positive().safe(), title: z.string().max(1000), state: z.enum(['open','closed']), merged_at: stamp, updated_at: stamp, html_url: z.string().max(4000), head: z.object({ sha, repo: z.object({ id: providerId }).nullable() }), base: z.object({ sha }) });
const checkSchema = z.object({ id: providerId, name: z.string().min(1).max(1000), head_sha: sha, status: z.enum(['queued','in_progress','completed','waiting','requested','pending']), conclusion: z.string().max(100).nullable(), completed_at: stamp, started_at: stamp, html_url: z.string().max(4000) });
const repoStateSchema = repoSchema.extend({ headSha: sha });
const pendingCheckSchema = z.object({ sha, prNumber: z.number().int().positive().safe().nullable(), headRepositoryId: providerId.nullable() }).strict();
const stateSchema = z.object({ repository: repoSchema.nullable(), headSha: sha.nullable(), fileIndex: z.number().int().min(0).max(50), pullContinuation: z.string().max(8000).nullable(), checks: z.array(pendingCheckSchema).max(100), checkContinuation: z.string().max(8000).nullable(), resume: z.enum(['pulls','done']) }).strict();
type State = z.infer<typeof stateSchema>;
const facets = new Set(['repository','branch','file','pulls','checks']);
const etagEntrySchema=z.object({requestHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.string().min(1).max(1500).regex(/^[\x20-\x7e]+$/)}).strict();
const etagSchema = z.object({ version: z.literal(1), selectionHash: z.string().regex(/^[a-f0-9]{64}$/), entries:z.array(etagEntrySchema).max(16).refine(entries=>new Set(entries.map(row=>row.requestHash)).size===entries.length) }).strict();
function invalid(message: string): never { throw new SourceReadError('invalid_content', message); }
function abort(signal: AbortSignal): void { if (signal.aborted) throw new SourceReadError('timeout','GitHub read was cancelled; no cursor was committed.'); }
async function cancellable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  abort(signal); let listener!: () => void;
  const stopped = new Promise<never>((_, reject) => { listener=()=>reject(new SourceReadError('timeout','GitHub read was cancelled; no cursor was committed.'));signal.addEventListener('abort',listener,{once:true}); });
  try { return await Promise.race([value,stopped]); } finally { signal.removeEventListener('abort',listener); }
}
async function readBody(body: Uint8Array | ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  if (body instanceof Uint8Array) { if (body.length>SOURCE_LIMITS.pageBytes) invalid('GitHub response exceeds 2 MiB.'); return body.slice(); }
  const reader=body.getReader(), chunks:Uint8Array[]=[];let length=0;
  try { for(;;){const next=await cancellable(reader.read(),signal);if(next.done)break;if(!(next.value instanceof Uint8Array)||next.value.length>SOURCE_LIMITS.pageBytes-length)invalid('GitHub response exceeds its byte bound.');length+=next.value.length;chunks.push(next.value.slice());} }
  finally { void reader.cancel().catch(()=>{});reader.releaseLock(); }
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
function githubUrl(value:string,repository?:string,expectedPath?:string):string {
  let url:URL;try{url=new URL(value);}catch{return invalid('Invalid GitHub citation URL.');}
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.port||url.search||url.hash||/[\u0000-\u0020\u007f\\]/u.test(value))invalid('Unsupported GitHub citation URL.');
  if(repository && !(url.pathname===`/${repository}`||url.pathname.startsWith(`/${repository}/`)))invalid('GitHub citation repository differs.');
  if(expectedPath!==undefined&&url.pathname!==expectedPath)invalid('GitHub citation path differs.');
  return value;
}
function nextLink(headers:Record<string,string>,request:GithubReadRequest,repository:string):string|null {
  const link=headers.link;if(!link)return null;if(link.length>16000)invalid('GitHub pagination header exceeds its bound.');
  const next=[...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)].filter(match=>match[2].split(/\s+/).includes('next'));
  if(![...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)].length)invalid('Malformed GitHub pagination header.');
  if(next.length>1)invalid('Ambiguous GitHub next page.');if(!next.length)return null;
  const value=next[0][1];validateContinuation(value,request,repository);return value;
}
function validateContinuation(value:string,request:GithubReadRequest,repository:string):void {
  let url:URL;try{url=new URL(value);}catch{return invalid('Invalid GitHub page continuation.');}
  const path=request.operation==='pulls'?`/repos/${repository}/pulls`:request.operation==='checks'?`/repos/${repository}/commits/${request.headSha}/check-runs`:'';
  if(value.length>8000||url.protocol!=='https:'||url.hostname!=='api.github.com'||url.username||url.password||url.port||url.hash||url.pathname!==path)invalid('GitHub continuation leaves the selected resource.');
  const allowed=request.operation==='pulls'?{state:'all',sort:'created',direction:'asc'}:{filter:'all'};
  for(const key of url.searchParams.keys())if(!['page','per_page',...Object.keys(allowed)].includes(key)||url.searchParams.getAll(key).length!==1)invalid('Unsupported GitHub pagination query.');
  const page=url.searchParams.get('page');if(!page||!/^[1-9][0-9]{0,6}$/.test(page))invalid('Invalid GitHub page number.');
  if('pageSize'in request&&url.searchParams.has('per_page')&&url.searchParams.get('per_page')!==String(request.pageSize))invalid('GitHub page representation changed.');
  for(const [key,expected]of Object.entries(allowed))if(url.searchParams.has(key)&&url.searchParams.get(key)!==expected)invalid('GitHub page filter changed.');
}
function rateDelay(headers:Record<string,string>,now:string):number {
  const value=headers['retry-after'];if(value){if(/^\d+$/.test(value))return Math.min(Number(value)*1000,86_400_000);const date=Date.parse(value);if(Number.isFinite(date))return Math.max(0,Math.min(date-Date.parse(now),86_400_000));}
  const reset=headers['x-ratelimit-reset'];if(reset&&/^\d+$/.test(reset))return Math.max(0,Math.min(Number(reset)*1000-Date.parse(now),86_400_000));return 60_000;
}
export function createGithubAdapter(options:GithubAdapterOptions={}):SourceAdapter {
  const mode=options.mode??'interactive',pageSize=options.pageSize??50,verification=options.verification?structuredClone(options.verification):undefined;
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('GitHub page size must be 1–100.');
  if(verification){evidenceDateSchema.nullable().parse(verification.interactiveAt);evidenceDateSchema.nullable().parse(verification.unattendedAt);if(!verification.connectionId||new Set(verification.resourceIds).size!==verification.resourceIds.length||verification.resourceIds.some(id=>!providerId.safeParse(id).success))throw new Error('Invalid verified GitHub resource configuration.');}
  const verifiedAt=(requested:AccessMode)=>verification?(requested==='interactive'?verification.interactiveAt:verification.unattendedAt):null;
  return {
    async capabilities(requested){const enabled=!!options.transport&&!!verification?.resourceIds.length&&!!verifiedAt(requested);return {sourceKinds:['github_repository','github_file'],interactiveRead:!!options.transport&&!!verification?.resourceIds.length&&!!verifiedAt('interactive'),unattendedRead:!!options.transport&&!!verification?.resourceIds.length&&!!verifiedAt('unattended'),verifiedAt:enabled?verifiedAt(requested):null,blockedReason:enabled?null:'Hosted GitHub access is unsupported until Sites eligibility, owner/resource scope and this access mode are explicitly verified.'};},
    async readPage(input,context){
      try {
        abort(context.signal);const target=sourceTargetSchema.parse(input);evidenceDateSchema.parse(context.observedAt);
        if(!['github_repository','github_file'].includes(target.kind)||target.archivedAt)throw new SourceReadError('unsupported','Select an active GitHub source.');
        if(!options.transport||!verification||!verifiedAt(mode))throw new SourceReadError('unsupported','No verified hosted GitHub read capability exists for this mode.');
        if(target.connectionId!==verification.connectionId||!verification.resourceIds.includes(target.providerResourceId))throw new SourceReadError('revoked','GitHub resource is outside the verified owner selection.');
        providerId.parse(target.providerResourceId);
        if(target.canonicalUrl){githubUrl(target.canonicalUrl);if(new URL(target.canonicalUrl).pathname.split('/').filter(Boolean).length!==2)invalid('Select a GitHub repository URL.');}
        if(target.kind==='github_file'&&!target.selectedPaths.length)invalid('Select at least one exact repository file path.');
        const selectionHash=await contentHash(canonical({target,pageSize}));
        let facet='repository',state:State={repository:null,headSha:null,fileIndex:0,pullContinuation:null,checks:[],checkContinuation:null,resume:target.kind==='github_repository'?'pulls':'done'};
        if(context.cursor){if(new TextEncoder().encode(context.cursor).length>SOURCE_LIMITS.cursorBytes)invalid('GitHub cursor exceeds its bound.');const cursor=sourceCursorSchema.parse(JSON.parse(context.cursor));if(cursor.selectionHash!==selectionHash||cursor.resourceId!==target.providerResourceId)throw new SourceReadError('configuration_changed','GitHub cursor belongs to another selection.');if(!facets.has(cursor.facet)||!cursor.continuation)invalid('Invalid GitHub cursor facet.');facet=cursor.facet;state=stateSchema.parse(JSON.parse(cursor.continuation));if(state.headSha!==cursor.pinnedRevision)invalid('GitHub cursor pin differs.');}
        if(context.cursor && (facet==='repository'||(facet==='branch'&&(state.headSha!==null||state.fileIndex!==0||state.checks.length))||(['pulls','checks'].includes(facet)&&(target.kind!=='github_repository'||state.fileIndex!==target.selectedPaths.length))||(facet==='file'&&(state.checks.length||state.checkContinuation||state.pullContinuation))||(facet==='pulls'&&(state.checks.length||state.checkContinuation))))invalid('GitHub cursor facet state is inconsistent.');
        const repo=state.repository;
        if(facet!=='repository'&&!repo)invalid('GitHub cursor lacks repository identity.');
        if(repo){if(repo.id!==target.providerResourceId)invalid('GitHub cursor repository differs.');githubUrl(repo.html_url,repo.full_name,`/${repo.full_name}`);}
        if(['file','pulls','checks'].includes(facet)&&!state.headSha)invalid('GitHub cursor lacks a pinned full SHA.');
        let request:GithubReadRequest;
        const base={repositoryId:target.providerResourceId,ifNoneMatch:null};
        if(facet==='repository')request={...base,operation:'repository'};
        else if(facet==='branch')request={...base,operation:'branch',branch:repo!.default_branch};
        else if(facet==='file'){if(state.fileIndex>=target.selectedPaths.length)invalid('GitHub file cursor exceeds selected paths.');request={...base,operation:'file',commitSha:state.headSha!,path:target.selectedPaths[state.fileIndex]};}
        else if(facet==='pulls')request={...base,operation:'pulls',continuation:state.pullContinuation,pageSize,state:'all',sort:'created',direction:'asc'};
        else {if(!state.checks.length)invalid('GitHub check cursor lacks a head.');request={...base,operation:'checks',headSha:state.checks[0].sha,continuation:state.checkContinuation,pageSize,filter:'all'};}
        if('continuation'in request&&request.continuation)validateContinuation(request.continuation,request,repo!.full_name);
        const requestHash=await contentHash(canonical({...request,representation:'github-json-v1'}));
        let etags:z.infer<typeof etagEntrySchema>[]=[];
        if(context.etag){if(context.etag.length>2000)invalid('GitHub ETag envelope exceeds its bound.');const old=etagSchema.parse(JSON.parse(context.etag));if(old.selectionHash!==selectionHash)throw new SourceReadError('configuration_changed','GitHub ETag belongs to another selection.');etags=old.entries;request.ifNoneMatch=etags.find(entry=>entry.requestHash===requestHash)?.value??null;}
        function etagValue(value:string|undefined):string|null{
          if(value){const entry=etagEntrySchema.parse({requestHash,value});etags=[...etags.filter(row=>row.requestHash!==requestHash),entry].slice(-16);}
          if(!etags.length)return null;
          let encoded=JSON.stringify(etagSchema.parse({version:1,selectionHash,entries:etags}));
          while(encoded.length>2000&&etags.length>1){etags.shift();encoded=JSON.stringify({version:1,selectionHash,entries:etags});}
          if(encoded.length>2000)invalid('GitHub ETag envelope exceeds its bound.');return encoded;
        }
        abort(context.signal);
        let response=await cancellable(options.transport.read(request,{signal:context.signal,maxBytes:SOURCE_LIMITS.pageBytes}),context.signal);
        let headers=Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key.toLowerCase(),value]));
        let bytes=await readBody(response.body,context.signal);abort(context.signal);
        let etag=etagValue(headers.etag);
        if(etag&&etag.length>2000)invalid('GitHub ETag exceeds its envelope bound.');
        if(response.status===304){
          if(!request.ifNoneMatch||bytes.length)invalid('Unsolicited or nonempty GitHub 304.');
          if(facet==='file'){
            state.fileIndex++;let nextFacet:string|null=state.fileIndex<target.selectedPaths.length?'file':null;
            if(!nextFacet&&target.kind==='github_repository'){state.checks=[{sha:state.headSha!,prNumber:null,headRepositoryId:target.providerResourceId}];nextFacet='checks';}
            const nextCursor=nextFacet?JSON.stringify(sourceCursorSchema.parse({version:1,selectionHash,resourceId:target.providerResourceId,facet:nextFacet,pinnedRevision:state.headSha,continuation:JSON.stringify(state),etag:null})):null;
            return sourcePageSchema.parse({observations:[],nextCursor,nextEtag:etag,unchanged:true});
          }
          // Aggregate metadata/pagination cannot be reconstructed from a 304.
          // One serial, bounded read without the conditional header preserves
          // independent PR/check facets instead of declaring the repository fresh.
          request={...request,ifNoneMatch:null};
          abort(context.signal);
          response=await cancellable(options.transport.read(request,{signal:context.signal,maxBytes:SOURCE_LIMITS.pageBytes}),context.signal);
          headers=Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key.toLowerCase(),value]));
          bytes=await readBody(response.body,context.signal);abort(context.signal);
          etag=etagValue(headers.etag);
          if(response.status===304)invalid('GitHub returned 304 for an unconditional read.');
        }
        if(response.status===429||response.status===403&&(headers['x-ratelimit-remaining']==='0'||headers['retry-after']||new TextDecoder().decode(bytes).toLowerCase().includes('rate limit')))throw new SourceReadError('rate_limited','GitHub rate limit reached.',rateDelay(headers,context.observedAt));
        if(response.status===401)throw new SourceReadError('reauthentication_required','GitHub access requires reauthentication.');
        if(response.status===403)throw new SourceReadError('connector_access_disabled','GitHub read permission is unavailable.');
        if(response.status===404)throw new SourceReadError('not_found','GitHub resource is missing or access was revoked; prior observations remain historical.');
        if(response.status!==200)throw new SourceReadError('upstream_error',`GitHub read returned HTTP ${response.status}.`);
        const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        const observations:SourceObservation[]=[];
        async function observe(externalId:string,revision:string,title:string,url:string|null,updated:string|null,payload:{[key:string]:JsonValue}){const contentDigest=await contentHash(canonical(payload));observations.push({id:`github:${await contentHash(canonical([target.id,externalId,revision,contentDigest]))}`,sourceId:target.id,externalId,sourceRevision:revision,sourceUpdatedAt:updated,observedAt:context.observedAt,title:title.slice(0,500)||'GitHub source',canonicalUrl:url,contentDigest,payload,origin:'provider-read'});}
        let nextFacet:string|null=null;
        function afterFiles(){state.checks=[{sha:state.headSha!,prNumber:null,headRepositoryId:target.providerResourceId}];nextFacet=target.kind==='github_repository'?'checks':null;}
        if(facet==='repository'){
          const value=repoSchema.parse(data);if(value.id!==target.providerResourceId)invalid('GitHub returned another immutable repository identity.');githubUrl(value.html_url,value.full_name,`/${value.full_name}`);state.repository=value;nextFacet='branch';
        }else if(facet==='branch'){
          const value=branchSchema.parse(data);if(value.name!==repo!.default_branch)invalid('GitHub resolved another branch.');state.headSha=value.commit.sha;
          const pinned=repoStateSchema.parse({...repo!,headSha:state.headSha});await observe(`repository:${repo!.id}`,state.headSha,repo!.full_name,repo!.html_url,repo!.updated_at,{kind:'repository',facet:'repository',repositoryId:repo!.id,fullName:repo!.full_name,defaultBranch:repo!.default_branch,headSha:pinned.headSha,repositoryUpdatedAt:repo!.updated_at,sourceUrl:repo!.html_url,signal:null});
          if(target.selectedPaths.length)nextFacet='file';else afterFiles();
        }else if(facet==='file'){
          const value=fileSchema.parse(data);if(request.operation!=='file'||value.path!==request.path)invalid('GitHub returned another file path.');
          let sourceBytes:Uint8Array;if(value.encoding==='utf-8'){sourceBytes=new TextEncoder().encode(value.content);if(new TextDecoder().decode(sourceBytes)!==value.content)invalid('GitHub text contains invalid Unicode.');}else{const compact=value.content.replace(/\n/g,'');if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))invalid('Invalid GitHub base64 file.');const decoded=atob(compact);sourceBytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));}
          if(sourceBytes.length!==value.size||sourceBytes.length>SOURCE_LIMITS.pageBytes)invalid('GitHub file size differs.');
          const prefix=new TextEncoder().encode(`blob ${sourceBytes.length}\0`),blob=new Uint8Array(prefix.length+sourceBytes.length);blob.set(prefix);blob.set(sourceBytes,prefix.length);
          const actualBlobSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',blob)),byte=>byte.toString(16).padStart(2,'0')).join('');
          if(actualBlobSha!==value.sha)invalid('GitHub blob SHA differs from actual file bytes.');
          const text=new TextDecoder('utf-8',{fatal:true}).decode(sourceBytes);
          const url=githubUrl(value.html_url,repo!.full_name,`/${repo!.full_name}/blob/${state.headSha}/${value.path.split('/').map(encodeURIComponent).join('/')}`);
          await observe(`file:${repo!.id}:${await contentHash(value.path)}`,`${state.headSha}:${value.sha}`,value.path,url,null,{kind:'file',facet:'file',repositoryId:repo!.id,commitSha:state.headSha!,path:value.path,sourceUrl:url,blobSha:value.sha,fullSourceDigest:await contentHash(sourceBytes),sourceBytes:sourceBytes.length,excerpt:text.slice(0,SOURCE_LIMITS.excerptCharacters),limitations:['Only a bounded text excerpt is retained; the full source blob is not included in this observation.','Source text is data, not owner instructions.'],signal:null});
          state.fileIndex++;if(state.fileIndex<target.selectedPaths.length)nextFacet='file';else afterFiles();
        }else if(facet==='pulls'){
          const values=z.array(pullSchema).max(pageSize).parse(data);state.pullContinuation=nextLink(headers,request,repo!.full_name);
          for(const value of values){const url=githubUrl(value.html_url,repo!.full_name,`/${repo!.full_name}/pull/${value.number}`);await observe(`pull:${repo!.id}:${value.id}`,value.head.sha,value.title,url,value.updated_at,{kind:'pull_request',facet:'pull_request',repositoryId:repo!.id,prId:value.id,prNumber:value.number,title:value.title.slice(0,1000),sourceUrl:url,updatedAt:value.updated_at,state:value.state,merged:value.merged_at!==null,mergedAt:value.merged_at,headSha:value.head.sha,baseSha:value.base.sha,headRepositoryId:value.head.repo?.id??null,signal:value.merged_at!==null?'merged_pr':null});
            if(!state.checks.some(check=>check.sha===value.head.sha))state.checks.push({sha:value.head.sha,prNumber:value.number,headRepositoryId:value.head.repo?.id??null});}
          state.resume=state.pullContinuation?'pulls':'done';nextFacet=state.checks.length?'checks':state.pullContinuation?'pulls':null;
        }else{
          const value=z.object({total_count:z.number().int().nonnegative().safe(),check_runs:z.array(checkSchema).max(pageSize)}).parse(data),head=state.checks[0];state.checkContinuation=nextLink(headers,request,repo!.full_name);
          for(const check of value.check_runs){const headMatches=check.head_sha===head.sha,failed=check.status==='completed'&&['failure','timed_out','cancelled','action_required','startup_failure'].includes(check.conclusion??'');const url=githubUrl(check.html_url,repo!.full_name);await observe(`check:${repo!.id}:${check.id}`,`${check.head_sha}:${check.status}:${check.conclusion??'unknown'}:${check.completed_at??'unknown'}`,check.name,url,check.completed_at??check.started_at,{kind:'check_run',facet:'check_run',repositoryId:repo!.id,checkId:check.id,name:check.name,sourceUrl:url,startedAt:check.started_at,completedAt:check.completed_at,headSha:check.head_sha,requestedHeadSha:head.sha,headMatches,prNumber:head.prNumber,headRepositoryId:head.headRepositoryId,status:check.status,conclusion:check.conclusion,signal:headMatches&&failed?'check_failure':null,limitations:headMatches?[]:['Check belongs to a different SHA and does not establish the selected head result.']});}
          if(state.checkContinuation)nextFacet='checks';else{state.checks.shift();nextFacet=state.checks.length?'checks':state.resume==='pulls'?'pulls':null;}
        }
        const nextCursor=nextFacet?JSON.stringify(sourceCursorSchema.parse({version:1,selectionHash,resourceId:target.providerResourceId,facet:nextFacet,pinnedRevision:state.headSha,continuation:JSON.stringify(stateSchema.parse(state)),etag:null} satisfies SourceCursor)):null;
        abort(context.signal);return sourcePageSchema.parse({observations,nextCursor,nextEtag:etag??null,unchanged:false});
      }catch(error){if(error instanceof SourceReadError)throw error;if(context.signal.aborted)throw new SourceReadError('timeout','GitHub read was cancelled.');if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof TypeError)throw new SourceReadError('invalid_content','GitHub response or cursor failed its strict content contract.');throw new SourceReadError('upstream_error','GitHub did not return a confirmed bounded read.');}
    },
  };
}
