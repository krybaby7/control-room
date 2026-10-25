/** Repository handoffs are untrusted evidence, never instructions or cloud transcript access. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,realpath,opendir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {forbiddenPath} from './snapshot.mjs';
import {chatTextHasSecret,redactChatText} from './chat-context.mjs';
const exec=promisify(execFile),DIRECTORY='planning/handoffs/owner-turns';
export const CLOUD_OWNER_LIMITS=Object.freeze({sessions:24,files:64,fileBytes:65536,totalBytes:524288,refs:24});
const MAX_ENTRIES=256,MAX_TREE_BYTES=262144,DEADLINE_MS=20000,GIT_MS=2000;
const candidate=/^planning\/handoffs\/owner-turns\/\d{4}-\d\d-\d\d-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/u;
const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
const same=(a,b)=>a.isFile()&&b.isFile()&&!a.isSymbolicLink()&&!b.isSymbolicLink()&&a.nlink===1&&b.nlink===1&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
async function safeDirectory(input,check){
 if(typeof input!=='string'||!path.isAbsolute(input)||input.startsWith('\\\\')||input.includes('\0'))throw new Error('Unsafe root.');
 const absolute=path.resolve(input);let cursor=path.parse(absolute).root;
 for(const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)){check();cursor=path.join(cursor,part);const info=await lstat(cursor);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Linked directory.');}
 if(normalize(await realpath(absolute))!==normalize(absolute))throw new Error('Noncanonical directory.');return absolute;
}
function gitEnvironment(){const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GCM_INTERACTIVE:'never'};}
async function git(root,args,signal,maxBuffer=MAX_TREE_BYTES){return (await exec('git',['-c','core.fsmonitor=false','-c','core.hooksPath=','-c','core.attributesFile=','-c','diff.external=','-c','credential.helper=','-c','protocol.allow=never','-C',root,...args],{signal,timeout:GIT_MS,env:gitEnvironment(),maxBuffer,encoding:'buffer',windowsHide:true})).stdout;}
const validRef=ref=>typeof ref==='string'&&( /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(ref)||/^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/u.test(ref)&&!ref.includes('..')&&!ref.includes('//')&&!ref.endsWith('/')&&!ref.endsWith('.')&&!ref.endsWith('.lock'));
function timestamp(value){if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value))return null;const number=Date.parse(value);if(!Number.isFinite(number))return null;const iso=new Date(number).toISOString();return iso===value||iso===value.replace(/Z$/u,'.000Z')?iso:null;}
function sanitize(text){if(chatTextHasSecret(text))return null;const cleaned=redactChatText(text);if(!cleaned)return null;return cleaned===text.trim()?text:cleaned;}
function parse(buffer){
 if(buffer.includes(0))throw new Error('Not text.');const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer),lines=[];let offset=0;
 for(const raw of text.split('\n')){lines.push({text:raw.replace(/\r$/u,''),start:offset,crlf:raw.endsWith('\r')});offset+=raw.length+1;}
 let cursor=0;const skip=()=>{while(cursor<lines.length&&lines[cursor].text==='')cursor++;};
 if(lines[cursor++]?.text!=='# Owner turns')throw new Error('Invalid heading.');skip();
 const provider=/^Provider: (claude-cloud|codex-cloud)$/u.exec(lines[cursor++]?.text??'')?.[1];
 const sessionId=/^Session: ([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(lines[cursor++]?.text??'')?.[1];
 const rawTitle=/^Title: (.{1,200})$/u.exec(lines[cursor++]?.text??'')?.[1],title=rawTitle&&sanitize(rawTitle);
 if(!provider||!sessionId||chatTextHasSecret(sessionId)||!title)throw new Error('Invalid metadata.');
 let truncated=title!==rawTitle,latestAt=null;const messages=[];skip();
 while(cursor<lines.length){
  const at=timestamp(/^## (.+)$/u.exec(lines[cursor++]?.text??'')?.[1]??'');
  const opening=lines[cursor++],fence=/^(`{3,})text$/u.exec(opening?.text??'')?.[1];if(!at||!fence)throw new Error('Invalid turn.');
  const start=lines[cursor]?.start;let end=-1;
  while(cursor<lines.length){if(lines[cursor].text===fence){end=lines[cursor].start;cursor++;break;}cursor++;}
  if(end<0||start===undefined)throw new Error('Unclosed turn.');
  // One newline is Markdown framing. Any earlier newline belongs to the original message.
  const interior=text.slice(start,end),framing=opening.crlf?'\r\n':'\n';if(!interior.endsWith(framing))throw new Error('Missing framing newline.');
  const raw=interior.slice(0,-framing.length),clean=sanitize(raw);
  latestAt=latestAt===null||at>latestAt?at:latestAt;
  if(clean===null)truncated=true;else{messages.push({role:'user',text:clean,timestamp:at});truncated||=clean!==raw;}
  skip();
 }
 if(!messages.length)throw new Error('No safe owner turns.');return {provider,sessionId,title,origin:'repository-handoff',latestAt,messages,truncated};
}
/** Reads the actual checkout and supplied fetched origin refs/SHA objects. Never fetches or checks out. */
export async function readCloudOwnerTurns({repositoryRoot,signal,refs=[]}={}){
 signal?.throwIfAborted();const timeout=AbortSignal.timeout(DEADLINE_MS),bounded=signal?AbortSignal.any([signal,timeout]):timeout;
 const check=()=>bounded.throwIfAborted();let truncated=false,unsafe=false,files=0,bytes=0;const sessions=new Map(),objects=new Set(),candidates=[];
 const reject=()=>{unsafe=true;truncated=true;};
 const accept=buffer=>{const session=parse(buffer),key=session.provider+'\0'+session.sessionId,previous=sessions.get(key);if(!previous||session.latestAt>previous.latestAt)sessions.set(key,session);truncated||=session.truncated;};
 const reserve=size=>{if(!Number.isSafeInteger(size)||size<0||size>CLOUD_OWNER_LIMITS.fileBytes||bytes+size>CLOUD_OWNER_LIMITS.totalBytes){reject();return false;}bytes+=size;return true;};
 try{
  check();const root=await safeDirectory(repositoryRoot,check),top=(await git(root,['rev-parse','--show-toplevel'],bounded)).toString('utf8').trim();if(normalize(await realpath(top))!==normalize(root))throw new Error('Use repository root.');
  try{
   const directory=await safeDirectory(path.join(root,...DIRECTORY.split('/')),check),entries=[];const handle=await opendir(directory);
   for await(const entry of handle){check();if(entries.length===MAX_ENTRIES){truncated=true;break;}entries.push(entry.name);}
   for(const name of entries){const relative=DIRECTORY+'/'+name;if(candidate.test(relative))candidates.push({relative,directory,name,priority:0});}
  }catch(error){check();if(error?.code!=='ENOENT')reject();}
  if(!Array.isArray(refs)){reject();refs=[];}if(refs.length>CLOUD_OWNER_LIMITS.refs)truncated=true;
  let priority=0;
  for(const ref of [...new Set(refs.slice(0,CLOUD_OWNER_LIMITS.refs))]){
   priority++;check();if(!validRef(ref)){reject();continue;}
   try{
    const sha=(await git(root,['rev-parse','--verify','--end-of-options',ref+'^{commit}'],bounded,256)).toString('ascii').trim();if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))throw new Error('Invalid object.');
    const tree=await git(root,['ls-tree','-r','-l','-z','--full-tree',sha,'--',DIRECTORY+'/'],bounded);const entries=tree.toString('utf8').split('\0').filter(Boolean);
    if(entries.length>MAX_ENTRIES)truncated=true;
    for(const entry of entries.sort((a,b)=>b.slice(b.indexOf('\t')+1).localeCompare(a.slice(a.indexOf('\t')+1))).slice(0,MAX_ENTRIES)){
     check();const match=/^(\d{6}) (\w+) ([a-f0-9]{40}(?:[a-f0-9]{24})?) +([0-9]+|-)\t(.+)$/u.exec(entry);if(!match)throw new Error('Invalid tree.');
     const [,mode,type,object,size,relative]=match;if(!candidate.test(relative))continue;if(objects.has(object))continue;
     objects.add(object);candidates.push({relative,mode,type,object,size:Number(size),priority});
    }
   }catch{check();reject();}
  }
  // Inventory all bounded sources before content reads, so older checkout files cannot
  // consume the entire file budget before a newer fetched handoff is considered.
  candidates.sort((a,b)=>b.relative.slice(DIRECTORY.length+1,DIRECTORY.length+11).localeCompare(a.relative.slice(DIRECTORY.length+1,DIRECTORY.length+11))||a.priority-b.priority||b.relative.localeCompare(a.relative));
  for(const item of candidates){
   check();if(files>=CLOUD_OWNER_LIMITS.files){truncated=true;break;}files++;
   if(forbiddenPath(item.relative)){reject();continue;}
   if(item.object){
    if(!['100644','100755'].includes(item.mode)||item.type!=='blob'||!reserve(item.size)){reject();continue;}
    try{const buffer=await git(root,['cat-file','blob',item.object],bounded,CLOUD_OWNER_LIMITS.fileBytes+1);if(buffer.length!==item.size)throw new Error('Object size mismatch.');accept(buffer);}catch{check();reject();}
   }else{
    let opened;try{
     await safeDirectory(item.directory,check);const absolute=path.join(item.directory,item.name),before=await lstat(absolute);
     if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!reserve(before.size)){reject();continue;}
     opened=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));if(!same(before,await opened.stat()))throw new Error('Unstable file.');
     const buffer=Buffer.alloc(before.size);let received=0;while(received<buffer.length){check();const read=await opened.read(buffer,received,buffer.length-received,received);if(!read.bytesRead)throw new Error('Short file.');received+=read.bytesRead;}
     await safeDirectory(item.directory,check);if(!same(before,await opened.stat())||!same(before,await lstat(absolute)))throw new Error('Changed file.');accept(buffer);
    }catch{check();reject();}finally{await opened?.close();}
   }
  }
 }catch{if(signal?.aborted)signal.throwIfAborted();reject();}
 const ordered=[...sessions.values()].sort((a,b)=>b.latestAt.localeCompare(a.latestAt)||a.provider.localeCompare(b.provider)||a.sessionId.localeCompare(b.sessionId));if(ordered.length>CLOUD_OWNER_LIMITS.sessions)truncated=true;
 const selected=ordered.slice(0,CLOUD_OWNER_LIMITS.sessions);return {status:selected.length?'included':unsafe||truncated?'unavailable':'not-found',sessions:selected,truncated};
}
