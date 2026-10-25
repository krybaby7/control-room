/** Bounded, read-only evidence pack for one project briefing: recent commits on local and
 * GitHub branches (after one `git fetch` with the PC's existing Git credentials), uncommitted
 * work, pull requests when the GitHub CLI is signed in, and the last few local Codex and
 * Claude Code chats for this repository. Everything is counted and clipped; nothing is
 * executed from the repository and no transcript leaves the PC except the clipped excerpts
 * that ride in the one model prompt. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {repositoryIdentity,digest,forbiddenPath,snapshotRepository} from './snapshot.mjs';
import {readCodexChatContext} from './codex-chat-context.mjs';
import {chatTextHasSecret,redactChatText} from './chat-context.mjs';
import {readCloudOwnerTurns,CLOUD_OWNER_LIMITS} from './cloud-owner-turns.mjs';
const exec=promisify(execFile);
export const EVIDENCE_LIMITS=Object.freeze({days:14,branches:24,commitsPerBranch:10,commits:160,pullRequests:25,sessionsPerProvider:5,messagesPerSession:10,charactersPerMessage:1200,charactersPerSession:2800,chatCharacters:16000,ownerSessions:24,readMessages:60,ownerTurnsPerSession:40,charactersPerTurn:700,ownerCharacters:28000,uncommittedPaths:40,bundleBytes:160000,fetchMs:60000,ghMs:20000});
const secretText=/(?:-----BEGIN .*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[=:]\s*["']?[^\s"']{8,}|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{12,}|\bAKIA[0-9A-Z]{16}\b)/i;
const clean=(text,max)=>{const value=String(text??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'').trim();if(secretText.test(value))return '[filtered]';return value.length>max?value.slice(0,max-1)+'…':value;};
function gitEnvironment(network){const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','USERPROFILE','HOME','LOCALAPPDATA','APPDATA','SSH_AUTH_SOCK'])if(process.env[key])env[key]=process.env[key];
 // Network reads keep the user's own credential helper configuration but never prompt.
 Object.assign(env,network?{GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_OPTIONAL_LOCKS:'0'}:{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0'});return env;}
async function git(root,args,{signal,timeout=15000,network=false}={}){return (await exec('git',['-c','core.fsmonitor=false','-c','core.hooksPath=','-c','diff.external=','-c','protocol.ext.allow=never','-C',root,...args],{signal,timeout,env:gitEnvironment(network),encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true})).stdout;}
/** Host and path of a remote URL without credentials; other configured remotes (local paths) are named without exposing them. */
export function remoteIdentity(raw){if(typeof raw!=='string'||raw.length>4096||!raw.trim())return null;try{const u=new URL(raw.trim().replace(/^git@([^:]+):/,'ssh://git@$1/'));if(!['https:','ssh:','git:'].includes(u.protocol)||u.search||u.hash)return 'local-remote';return (u.host.toLowerCase()+'/'+u.pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/i,'')).slice(0,200);}catch{return 'local-remote';}}
const lines=text=>text.split('\n').map(line=>line.replace(/\r$/,'')).filter(Boolean);
async function readRefs(root,prefix,signal){const out=await git(root,['for-each-ref','--sort=-committerdate','--format=%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)',prefix],{signal}).catch(()=>'');return lines(out).map(line=>{const [name,sha,at]=line.split('\u001f');return {name,sha,at:Number.isFinite(Date.parse(at))?new Date(at).toISOString():null};}).filter(ref=>ref.name&&/^[a-f0-9]{40,64}$/.test(ref.sha)&&!/\/HEAD$/.test(ref.name)&&ref.name!=='HEAD');}
async function readCommits(root,ref,since,signal,max){const out=await git(root,['log',ref,'-n',String(max),'--since='+since,'--no-decorate','--format=%H%x1f%cI%x1f%an%x1f%s'],{signal}).catch(()=>'');return lines(out).map(line=>{const [sha,at,author,subject]=line.split('\u001f');return {sha:sha.slice(0,10),at:Number.isFinite(Date.parse(at))?new Date(at).toISOString():null,author:clean(author,60),subject:clean(subject,140)};}).filter(row=>row.sha);}
async function defaultBranch(root,remote,locals,signal){
 if(remote){const head=(await git(root,['symbolic-ref','-q','--short','refs/remotes/origin/HEAD'],{signal}).catch(()=>'')).trim();if(head)return head;for(const name of ['origin/main','origin/master'])if(await git(root,['rev-parse','--verify','-q',name+'^{commit}'],{signal}).then(()=>true,()=>false))return name;}
 for(const name of ['main','master'])if(locals.some(ref=>ref.name===name))return name;return locals[0]?.name??null;
}
async function compare(root,base,ref,signal){if(!base||base===ref)return {ahead:null,behind:null,merged:null};const counts=(await git(root,['rev-list','--left-right','--count',`${base}...${ref}`],{signal}).catch(()=>'')).trim().split(/\s+/);const behind=Number(counts[0]),ahead=Number(counts[1]);const merged=await git(root,['merge-base','--is-ancestor',ref,base],{signal}).then(()=>true,error=>error?.code===1?false:null);return {ahead:Number.isSafeInteger(ahead)?ahead:null,behind:Number.isSafeInteger(behind)?behind:null,merged};}
async function readUncommitted(root,signal){const status=(await git(root,['status','--porcelain=v1','-z','--untracked-files=normal','--ignore-submodules=all'],{signal}).catch(()=>'')).split('\0').filter(Boolean);const paths=[];for(const entry of status){const path=entry.slice(3).replaceAll('\\','/');if(!path)continue;paths.push(forbiddenPath(path)?'[excluded path]':clean(path,160));}const shortstat=clean((await git(root,['diff','--shortstat','--ignore-submodules=all','HEAD'],{signal}).catch(()=>'')).trim(),200);const result={files:status.length,paths:paths.slice(0,EVIDENCE_LIMITS.uncommittedPaths),summary:shortstat||null};
 // Reuse the bounded source reader's path, link, secret and cancellation rules.
 // Only its digest participates locally; source excerpts never enter this bundle.
 if(status.length){const snapshot=await snapshotRepository(root,{signal});Object.defineProperty(result,'contentFingerprint',{value:snapshot.sha256});}
 return result;}
async function readPullRequests(remote,signal,{ghMs=EVIDENCE_LIMITS.ghMs}={}){
 const match=/^github\.com\/([^/]+\/[^/]+)$/.exec(remote??'');if(!match)return null;
 const env={...gitEnvironment(true),GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',NO_COLOR:'1'};
 try{const out=(await exec(process.platform==='win32'?'gh.exe':'gh',['pr','list','--repo',match[1],'--state','all','--limit',String(EVIDENCE_LIMITS.pullRequests),'--json','number,title,state,isDraft,headRefName,baseRefName,updatedAt,mergedAt,reviewDecision,author'],{signal,timeout:ghMs,env,encoding:'utf8',maxBuffer:1024*1024,windowsHide:true})).stdout;
  const rows=JSON.parse(out);if(!Array.isArray(rows))return null;
  return rows.slice(0,EVIDENCE_LIMITS.pullRequests).map(row=>({number:Number.isSafeInteger(row.number)?row.number:null,title:clean(row.title,140),state:clean(row.state,20).toLowerCase(),draft:row.isDraft===true,head:clean(row.headRefName,120),base:clean(row.baseRefName,120),updatedAt:Number.isFinite(Date.parse(row.updatedAt))?new Date(row.updatedAt).toISOString():null,mergedAt:row.mergedAt&&Number.isFinite(Date.parse(row.mergedAt))?new Date(row.mergedAt).toISOString():null,review:clean(row.reviewDecision??'',40)||null,author:clean(row.author?.login??'',60)||null})).filter(row=>row.number!==null);
 }catch{return null;}
}
const omission='[… omitted …]';
const cloudProviders=Object.freeze(['claude-cloud','codex-cloud']);
function shorten(text,limit){if(text.length<=limit)return text;const available=limit-omission.length,head=Math.ceil(available/2);return text.slice(0,head)+omission+text.slice(-(available-head));}
/** Whole messages that look like credentials are dropped; local paths are redacted. */
export function sanitizeSessions(raw,provider){
 const sessions=Array.isArray(raw?.sessions)?raw.sessions:raw?.status==='included'&&Array.isArray(raw.messages)?[{latestAt:raw.latestAt,messages:raw.messages,truncated:raw.truncated}]:[];
 const kept=[];let messages=0,characters=0;
 for(const session of sessions.slice(0,EVIDENCE_LIMITS.sessionsPerProvider)){
  const latestAt=typeof session.latestAt==='string'&&Number.isFinite(Date.parse(session.latestAt))?new Date(session.latestAt).toISOString():null;
  const selected=[];let budget=EVIDENCE_LIMITS.charactersPerSession,truncated=!!session.truncated;
  for(const row of (Array.isArray(session.messages)?session.messages:[]).slice(-EVIDENCE_LIMITS.messagesPerSession)){
   if(!['user','assistant'].includes(row?.role)||typeof row.text!=='string'||Buffer.byteLength(row.text)>65536||chatTextHasSecret(row.text)){truncated=true;continue;}
   const text=shorten(redactChatText(row.text),Math.min(EVIDENCE_LIMITS.charactersPerMessage,budget));if(!text){truncated=true;continue;}
   if(text!==row.text)truncated=true;selected.push({role:row.role,text});budget-=text.length;if(budget<=0){truncated=true;break;}
  }
  if(!selected.length)continue;
  kept.push({latestAt,messages:selected,truncated});messages+=selected.length;characters+=selected.reduce((sum,row)=>sum+row.text.length,0);
 }
 const status=kept.length?'included':raw?.status==='not-found'?'not-found':'unavailable';
 return {summary:{provider,status,sessions:kept.length,messages,latestAt:kept[0]?.latestAt??null},sessions:kept,characters};
}
/** The owner's own turns, kept apart from the clipped conversation excerpts: these are where the owner's
 * intentions are stated. Whole turns that look like credentials are dropped; local paths are redacted. */
export function ownerTurnsFrom(raw,provider){
 const sessions=Array.isArray(raw?.sessions)?raw.sessions:[];
 const kept=[];
 for(const session of sessions.slice(0,EVIDENCE_LIMITS.ownerSessions)){
  const latestAt=typeof session.latestAt==='string'&&Number.isFinite(Date.parse(session.latestAt))?new Date(session.latestAt).toISOString():null;
  const turns=[],turnTimestamps=[];let truncated=!!session.truncated;
  for(const row of (Array.isArray(session.messages)?session.messages:[])){
   if(row?.role!=='user'||typeof row.text!=='string')continue;
   if(Buffer.byteLength(row.text)>65536||chatTextHasSecret(row.text)){truncated=true;continue;}
   const text=shorten(redactChatText(row.text).trim(),EVIDENCE_LIMITS.charactersPerTurn);if(!text){truncated=true;continue;}
   if(text!==row.text)truncated=true;turns.push(text);turnTimestamps.push(typeof row.timestamp==='string'&&Number.isFinite(Date.parse(row.timestamp))?new Date(row.timestamp).toISOString():null);
  }
  if(!turns.length)continue;
  if(turns.length>EVIDENCE_LIMITS.ownerTurnsPerSession){truncated=true;const excess=turns.length-EVIDENCE_LIMITS.ownerTurnsPerSession;turns.splice(0,excess);turnTimestamps.splice(0,excess);}
  const metadata={};
  if(cloudProviders.includes(provider)){
   metadata.source='cloud';metadata.origin='repository-handoff';metadata.turnTimestamps=turnTimestamps;
   for(const [key,limit] of [['sessionId',128],['title',200]])if(typeof session[key]==='string'&&!chatTextHasSecret(session[key])){const value=clean(redactChatText(session[key]),limit);if(value)metadata[key]=value;}
  }
  kept.push({provider,latestAt,turns,truncated,...metadata});
 }
 return kept;
}
/** Newest sessions first, but every session newer than the previous briefing comes before any older one,
 * so the ledger always sees what changed since. Older sessions fill the remaining budget. */
export function selectOwnerSessions(sessions,{previousUntil=null,budget=EVIDENCE_LIMITS.ownerCharacters}={}){
 const since=previousUntil?Date.parse(previousUntil):null;
 const at=row=>row.latestAt?Date.parse(row.latestAt):0;
 const fresh=since===null?[...sessions]:sessions.filter(row=>at(row)>since),old=since===null?[]:sessions.filter(row=>at(row)<=since);
 const ordered=[...fresh.sort((a,b)=>at(b)-at(a)),...old.sort((a,b)=>at(b)-at(a))];
 const picked=[];let used=0;
 for(const session of ordered){
  if(picked.length>=EVIDENCE_LIMITS.ownerSessions)break;
  const turns=[...session.turns],turnTimestamps=session.turnTimestamps?[...session.turnTimestamps]:null;let truncated=session.truncated;
  while(turns.length&&used+turns.reduce((sum,text)=>sum+text.length,0)>budget){turns.shift();turnTimestamps?.shift();truncated=true;}
  if(!turns.length)break;
  used+=turns.reduce((sum,text)=>sum+text.length,0);
  picked.push({...session,turns,...(turnTimestamps?{turnTimestamps}:{}),truncated,sinceLastBriefing:since!==null&&at(session)>since});
 }
 const stamps=picked.map(row=>row.latestAt).filter(Boolean).sort();
 const summary={sessions:picked.length,turns:picked.reduce((sum,row)=>sum+row.turns.length,0),characters:used,earliestAt:stamps[0]??null,latestAt:stamps.at(-1)??null};
 return {sessions:picked,summary};
}
async function readChats(root,{signal,codexHome,claudeHome,previousUntil=null,refs=[]}){
 const codex=await readCodexChatContext({repositoryRoot:root,signal,configRoot:codexHome,maxSessions:EVIDENCE_LIMITS.ownerSessions,maxMessages:EVIDENCE_LIMITS.readMessages}).catch(()=>{signal?.throwIfAborted();return {provider:'codex',status:'unavailable',messages:[]};});
 const claude=await import('./claude-chat-context.mjs').then(m=>m.readClaudeChatContext({repositoryRoot:root,signal,configRoot:claudeHome,maxSessions:EVIDENCE_LIMITS.ownerSessions,maxMessages:EVIDENCE_LIMITS.readMessages})).catch(()=>{signal?.throwIfAborted();return {provider:'claude',status:'unavailable',messages:[]};});
 const cloud=await readCloudOwnerTurns({repositoryRoot:root,signal,refs:refs.slice(0,CLOUD_OWNER_LIMITS.refs)}).catch(()=>{signal?.throwIfAborted();return {status:'unavailable',sessions:[]};});
 const clean=[sanitizeSessions(codex,'codex'),sanitizeSessions(claude,'claude')];
 let characters=clean.reduce((sum,row)=>sum+row.characters,0);
 // Trim the oldest sessions first until the chat budget holds.
 while(characters>EVIDENCE_LIMITS.chatCharacters){const longest=clean.filter(row=>row.sessions.length).sort((a,b)=>b.sessions.length-a.sessions.length)[0];if(!longest)break;const dropped=longest.sessions.pop();longest.summary.sessions=longest.sessions.length;longest.summary.messages-=dropped.messages.length;longest.characters-=dropped.messages.reduce((sum,row)=>sum+row.text.length,0);if(!longest.sessions.length)longest.summary.status='unavailable';characters=clean.reduce((sum,row)=>sum+row.characters,0);}
 const cloudSessions=cloudProviders.flatMap(provider=>ownerTurnsFrom({...cloud,sessions:cloud.sessions.filter(row=>row.provider===provider)},provider));
 const owner=selectOwnerSessions([...ownerTurnsFrom(codex,'codex'),...ownerTurnsFrom(claude,'claude'),...cloudSessions.slice(0,CLOUD_OWNER_LIMITS.sessions)],{previousUntil});
 // Only sanitized cloud content participates in this local digest. It is independent of
 // the previous ledger and final pack trimming, so a new safe turn triggers refresh.
 const cloudOwnerSha256=digest(JSON.stringify({status:cloud.status,truncated:cloud.truncated===true,sessions:cloudSessions}));
 return {chats:clean,owner,cloud,cloudOwnerSha256};
}
/** Collect the evidence pack. `fetchRemote=false` skips the network read (stale remote refs are still used). */
export async function collectBriefingEvidence(root,{signal,now=()=>new Date().toISOString(),days=EVIDENCE_LIMITS.days,fetchRemote=true,codexHome,claudeHome,pullRequests=readPullRequests,previous=null}={}){
 signal?.throwIfAborted();
 const identity=await repositoryIdentity(root,{signal}),until=now(),since=new Date(Date.parse(until)-days*86400000).toISOString();
 const branch=(await git(identity.root,['symbolic-ref','-q','--short','HEAD'],{signal}).catch(()=>'')).trim()||null;
 const remoteUrl=(await git(identity.root,['config','--local','--get','remote.origin.url'],{signal}).catch(()=>'')).trim(),remote=remoteIdentity(remoteUrl);
 let cloudStatus='no-remote',fetchedAt=null,fetchError=null;
 if(remote){cloudStatus='stale';if(fetchRemote){try{await git(identity.root,['fetch','--prune','--no-recurse-submodules','--quiet','origin'],{signal,timeout:EVIDENCE_LIMITS.fetchMs,network:true});cloudStatus='fetched';fetchedAt=now();}catch(error){if(signal?.aborted)throw error;fetchError='GitHub could not be reached from this PC; branches below are as last fetched.';}}}
 const locals=(await readRefs(identity.root,'refs/heads',signal)).slice(0,EVIDENCE_LIMITS.branches);
 const remotes=remote?(await readRefs(identity.root,'refs/remotes/origin',signal)).slice(0,EVIDENCE_LIMITS.branches):[];
 if(remote&&!remotes.length&&cloudStatus==='stale')cloudStatus='unavailable';
 const base=await defaultBranch(identity.root,remote,locals,signal);
 const seen=new Set();let total=0;
 async function describe(refs,scope){const result=[];for(const ref of refs){signal?.throwIfAborted();if(total>=EVIDENCE_LIMITS.commits)break;const commits=(await readCommits(identity.root,ref.name,since,signal,EVIDENCE_LIMITS.commitsPerBranch)).filter(row=>!seen.has(row.sha));for(const row of commits)seen.add(row.sha);total+=commits.length;const relation=await compare(identity.root,base,ref.name,signal);result.push({name:clean(ref.name,120),scope,lastCommitAt:ref.at,isDefault:ref.name===base,...relation,commits});}return result;}
 const localBranches=await describe(locals,'local'),cloudBranches=await describe(remotes,'cloud');
 const uncommitted=await readUncommitted(identity.root,signal);
 const prs=remote&&/^github\.com\//.test(remote)?await pullRequests(remote,signal):null;
 const {chats,owner,cloud,cloudOwnerSha256}=await readChats(identity.root,{signal,codexHome,claudeHome,previousUntil:previous?.until??null,refs:remotes.map(ref=>ref.sha)});
 const latest=rows=>rows.map(row=>row.lastCommitAt).filter(Boolean).sort().at(-1)??null;
 const bundle={repository:{name:identity.name,branch,head:identity.head,dirty:identity.dirty,defaultBranch:base,remote,cloudStatus,fetchError},window:{since,until},localBranches,cloudBranches,uncommitted,pullRequests:prs,chats:chats.map(row=>({provider:row.summary.provider,status:row.summary.status,sessions:row.sessions})),ownerTurns:owner.sessions,previous};
 while(Buffer.byteLength(JSON.stringify(bundle))>EVIDENCE_LIMITS.bundleBytes){const longest=[...bundle.localBranches,...bundle.cloudBranches].sort((a,b)=>b.commits.length-a.commits.length)[0];if(longest?.commits.length)longest.commits.pop();else{const chat=bundle.chats.filter(row=>row.sessions.length).sort((a,b)=>Date.parse(a.sessions.at(-1).latestAt??0)-Date.parse(b.sessions.at(-1).latestAt??0))[0];if(chat)chat.sessions.pop();else if(bundle.ownerTurns.length)bundle.ownerTurns.pop();else throw new Error('Briefing evidence exceeds the finite bundle bound.');}}
 // Coverage describes the final retained pack, including any byte-budget omissions.
 const ownerSummary=selectOwnerSessions(bundle.ownerTurns,{previousUntil:previous?.until??null}).summary;
 const chatSummaries=bundle.chats.map(row=>({provider:row.provider,status:row.sessions.length?'included':row.status==='not-found'?'not-found':'unavailable',sessions:row.sessions.length,messages:row.sessions.reduce((sum,session)=>sum+session.messages.length,0),latestAt:row.sessions[0]?.latestAt??null}));
 const cloudTurns=cloudProviders.map(provider=>{const retained=bundle.ownerTurns.filter(row=>row.provider===provider),available=cloud.sessions.some(row=>row.provider===provider);return {provider,status:retained.length?'included':cloud.status==='unavailable'||cloud.truncated||available?'unavailable':'not-found',sessions:retained.length,turns:retained.reduce((sum,row)=>sum+row.turns.length,0)};});
 const summary={window:{since,until},local:{branch,commits:localBranches.reduce((sum,row)=>sum+row.commits.length,0),branches:localBranches.length,latestCommitAt:latest(localBranches),uncommittedFiles:uncommitted.files},cloud:{status:cloudStatus,remote,branches:cloudBranches.length,commits:cloudBranches.reduce((sum,row)=>sum+row.commits.length,0),latestCommitAt:latest(cloudBranches),pullRequests:prs?prs.length:null,openPullRequests:prs?prs.filter(row=>row.state==='open').length:null,fetchedAt},chats:chatSummaries,cloudTurns,plan:null,ownerTurns:ownerSummary,previous:previous?{runId:previous.runId,until:previous.until,intentions:previous.intentions.length}:null,inputSha256:digest(JSON.stringify(bundle))};
 return {identity,branch,bundle,summary,fingerprint:workFingerprint({head:identity.head,uncommitted,locals,remotes,chats:chats.map(row=>row.summary.latestAt),cloudOwnerSha256})};
}
function workFingerprint({head,uncommitted,locals,remotes,chats,cloudOwnerSha256}){return digest(JSON.stringify({head,uncommitted:uncommitted.paths,contentFingerprint:uncommitted.contentFingerprint??null,locals:locals.map(ref=>[ref.name,ref.sha]),remotes:remotes.map(ref=>[ref.name,ref.sha]),chats,cloudOwnerSha256}));}
/** Bounded change detector: heads, safe source content, remote refs and chat recency. */
export async function computeWorkFingerprint(root,{signal,fetchRemote=true,codexHome,claudeHome}={}){
 signal?.throwIfAborted();const identity=await repositoryIdentity(root,{signal});
 const remoteUrl=(await git(identity.root,['config','--local','--get','remote.origin.url'],{signal}).catch(()=>'')).trim(),remote=remoteIdentity(remoteUrl);
 if(remote&&fetchRemote)await git(identity.root,['fetch','--prune','--no-recurse-submodules','--quiet','origin'],{signal,timeout:EVIDENCE_LIMITS.fetchMs,network:true}).catch(error=>{if(signal?.aborted)throw error;});
 const locals=(await readRefs(identity.root,'refs/heads',signal)).slice(0,EVIDENCE_LIMITS.branches),remotes=remote?(await readRefs(identity.root,'refs/remotes/origin',signal)).slice(0,EVIDENCE_LIMITS.branches):[];
 const uncommitted=await readUncommitted(identity.root,signal),{chats,cloudOwnerSha256}=await readChats(identity.root,{signal,codexHome,claudeHome,refs:remotes.map(ref=>ref.sha)});
 return workFingerprint({head:identity.head,uncommitted,locals,remotes,chats:chats.map(row=>row.summary.latestAt),cloudOwnerSha256});
}
