import {opendir,open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,basename,dirname,sep} from 'node:path';
import {readJsonl,JSONL_LIMITS} from '../readers/jsonl.mjs';
import {normalizeText,sha256,stableId} from '../readers/normalize.mjs';

export const CLAUDE_CODE_PARSER_VERSION='claude-code-local-v1';
const defaults={maxFiles:2000,maxDirectories:2000,maxDepth:12,maxFileBytes:8_000_000,maxLineBytes:512_000,maxRecords:10000,maxMessageBytes:256_000,maxAttachmentBytes:512_000,pageMessages:100,maxIndexEntries:1000,maxConversations:100,maxGaps:100,maxInventoryBytes:64_000_000,maxEntries:10000};
const encoder=new TextEncoder();
class AssetStagingError extends Error {}
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const abort=signal=>signal?.throwIfAborted();
async function boundedFile(path,maximum,signal){
 abort(signal);const expected=await lstat(path);if(!expected.isFile()||expected.isSymbolicLink()||expected.size>maximum||await realpath(path)!==path)throw new Error('file_bound_or_scope');
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{const current=await file.stat();if(current.dev!==expected.dev||current.ino!==expected.ino||await realpath(path)!==path)throw new Error('file_replaced');
  const chunks=[];let total=0;while(true){abort(signal);const buffer=Buffer.alloc(Math.min(65536,maximum-total+1));const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maximum)throw new Error('file_bound');chunks.push(buffer.subarray(0,bytesRead));}return Buffer.concat(chunks,total);
 }finally{await file.close();}
}

function safeNative(value,fallback){return typeof value==='string'&&value.length>0&&value.length<=512?value:fallback;}
function exclusion(relativePath,patterns){return patterns.some(pattern=>relativePath===pattern||relativePath.startsWith(pattern.replace(/\/$/,'')+'/'));}
/** Configured-root, read-only acquisition. Local object keys are remapped by the
 * collector's staging transport before the immutable envelope is submitted. */
export function createClaudeCodeLocalAdapter({configuration,runId,stageAsset,stageObject,limits={},now=()=>new Date().toISOString(),scopeLabel='Configured Claude Code local roots'}){
 if(!configuration||configuration.kind!=='claude_code_local'||!Array.isArray(configuration.roots)||!configuration.roots.length||!configuration.sourceId||!runId)throw new Error('Configured Claude Code roots, source and run identity are required.');
 const stage=stageAsset??stageObject;if(typeof stage!=='function')throw new Error('An injected asset staging port is required.');
 for(const [key,value]of Object.entries(limits))if(!(key in defaults)||!Number.isSafeInteger(value)||value<1||value>defaults[key])throw new Error('Invalid bounded Claude Code reader limit.');
 const cap={...defaults,...limits};for(const value of Object.values(cap))if(!Number.isSafeInteger(value)||value<1)throw new Error('Reader bounds must be positive safe integers.');if(cap.maxFileBytes>JSONL_LIMITS.maxBytes||cap.maxLineBytes>JSONL_LIMITS.maxLineBytes||cap.maxRecords>JSONL_LIMITS.maxRecords)throw new Error('Reader bounds exceed shared streaming limits.');if(cap.pageMessages>250)throw new Error('Collection pages permit at most 250 messages.');
 const sourceId=configuration.sourceId,id=(...parts)=>stableId(sourceId,...parts),clock=()=>{const value=typeof now==='function'?now():now;const result=timestamp(value);if(!result)throw new Error('A valid observation time is required.');return result;};
 const observedAt=clock();
 let inventory=null;const parsedFiles=new Map(),staged=new Map();
 const gap=(kind,native,conversationId=null)=>({id:id('gap',kind,native),sourceId,conversationId,kind,explanation:`Claude Code local ${kind}: ${native.split(':')[0]}. Parser ${CLAUDE_CODE_PARSER_VERSION}.`,detectedAt:observedAt,resolvedAt:null});
 async function inspect(signal){
  const files=[],indexes=[],gaps=[];let directories=0,entriesSeen=0,exhausted=true;
  async function walk(path,root,depth,rootIndex){
   abort(signal);if(depth>cap.maxDepth||directories++>=cap.maxDirectories){exhausted=false;gaps.push(gap('inventory','directory_bound'));return;}
   let entries=[];try{const directory=await opendir(path);for await(const entry of directory){if(entriesSeen++>=cap.maxEntries){exhausted=false;gaps.push(gap('inventory','entry_bound'));break;}entries.push(entry);}}catch(error){abort(signal);gaps.push(gap('access','root_unreadable'));exhausted=false;return;}
   entries.sort((a,b)=>a.name.localeCompare(b.name));
   for(const entry of entries){abort(signal);const full=resolve(path,entry.name),rel=relative(root,full).split(sep).join('/');if(exclusion(rel,configuration.exclusions??[]))continue;
    if(entry.isSymbolicLink()){gaps.push(gap('scope',`symlink_excluded:${rootIndex}:${rel}`));continue;}
    if(entry.isDirectory()){await walk(full,root,depth+1,rootIndex);continue;}
    if(!entry.isFile())continue;
    if(entry.name==='sessions-index.json'||entry.name==='history.jsonl'){if(indexes.length>=cap.maxFiles){exhausted=false;gaps.push(gap('inventory','index_file_bound'));continue;}indexes.push({path:full,jsonl:entry.name==='history.jsonl',native:`${rootIndex}:${rel}`});continue;}
    if(!entry.name.endsWith('.jsonl'))continue;
    if(files.length>=cap.maxFiles){exhausted=false;gaps.push(gap('inventory','file_bound'));return;}
    files.push({path:full,native:`${rootIndex}:${rel}`,stem:basename(entry.name,'.jsonl'),subagent:rel.includes('/subagents/')||rel.startsWith('subagents/')});
   }
  }
  for(const [index,selected] of configuration.roots.entries()){
   if(typeof selected!=='string'||!selected)throw new Error('Configured roots must be nonempty paths.');
   const root=resolve(selected);try{const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error();await walk(root,root,0,index);}catch(error){abort(signal);gaps.push(gap('access',`root_unavailable:${index}`));exhausted=false;}
  }
  const hints=[],hintIds=new Set();let indexBytes=0;
  function addHint(entry){
   if(!entry||typeof entry.sessionId!=='string'||!entry.sessionId||entry.sessionId.length>512){gaps.push(gap('parse','unknown_index_entry'));return;}
   if(hintIds.has(entry.sessionId))return;
   if(hints.length>=cap.maxIndexEntries){exhausted=false;gaps.push(gap('inventory','total_index_entry_bound'));return;}
   hintIds.add(entry.sessionId);
   const promptTime=Number.isSafeInteger(entry.timestamp)&&entry.timestamp>=0?timestamp(new Date(entry.timestamp).toISOString()):timestamp(entry.timestamp);
   hints.push({sessionId:entry.sessionId,title:typeof entry.summary==='string'?entry.summary.slice(0,500):typeof entry.display==='string'?entry.display.slice(0,500):null,createdAt:timestamp(entry.created)??promptTime,sourceUpdatedAt:timestamp(entry.modified)});
  }
  for(const index of indexes){abort(signal);try{
   const raw=await boundedFile(index.path,cap.maxFileBytes,signal);indexBytes+=raw.length;
   if(indexBytes>cap.maxInventoryBytes){gaps.push(gap('inventory','index_byte_bound'));exhausted=false;break;}
   if(index.jsonl){for await(const event of readJsonl((async function*(){yield raw;})(),{signal,maxBytes:cap.maxFileBytes,maxLineBytes:cap.maxLineBytes,maxRecords:cap.maxRecords,maxDepth:40})){if(event.kind==='record')addHint(event.value);else{gaps.push(gap('parse',`prompt_index_${event.code}`));exhausted=false;}}}
   else{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(value.version!==1||!Array.isArray(value.entries))throw new Error();if(value.entries.length>cap.maxIndexEntries){gaps.push(gap('inventory','index_entry_bound'));exhausted=false;}for(const entry of value.entries.slice(0,cap.maxIndexEntries))addHint(entry);}
  }catch(error){abort(signal);gaps.push(gap('parse','invalid_session_index'));exhausted=false;}}
  const fingerprint=sha256(JSON.stringify({files:files.map(file=>file.native),hints,sourceId,scopeRevision:configuration.scopeRevision,epoch:configuration.epoch,runId}));
  const boundedGaps=gaps.slice(0,cap.maxGaps);if(gaps.length>cap.maxGaps)boundedGaps.push(gap('inventory',`additional_${gaps.length-cap.maxGaps}_diagnostics`));
  return {files,hints,gaps:boundedGaps,exhausted,fingerprint};
 }
 function conversation(native,title=null){return {id:id('conversation',native),sourceId,nativeThreadId:native,sessionTreeId:null,parentConversationId:null,title,projectId:null,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:null,availability:'complete'};}
 async function stageBytes(bytes,kind,nativeId,signal){
  abort(signal);const digest=sha256(bytes),cacheKey=kind+':'+digest;
  const object={key:`claude-local:${cacheKey}`,sha256:digest,bytes:bytes.length};
  if(!staged.has(cacheKey))staged.set(cacheKey,{...object,data:bytes,kind,nativeId});
  return object;
 }

 async function parseFile(file,signal){
  if(parsedFiles.has(file.native))return parsedFiles.get(file.native);
  parsedFiles.clear();staged.clear();
  let rawObject=null;
  const result={conversations:new Map(),messages:[],attachments:[],gaps:[],segments:[],seen:new Set(),digest:null};
  
  function getConversation(row={}){const session=safeNative(row.sessionId,file.subagent?basename(dirname(dirname(file.path))):file.stem),agent=file.subagent?safeNative(row.agentId,file.stem.replace(/^agent-/,'')):row.isSidechain&&typeof row.agentId==='string'?row.agentId:null,native=agent?`${session}:subagent:${agent}`:session;
   if(!result.conversations.has(native)){if(result.conversations.size>=cap.maxConversations)throw new Error('conversation_bound');const hint=inventory.hints.find(entry=>entry.sessionId===session),value=conversation(native,hint?.title??null);value.sessionTreeId=session;value.parentConversationId=agent?id('conversation',session):typeof row.parentSessionId==='string'?id('conversation',row.parentSessionId):null;value.createdAt=hint?.createdAt??null;value.sourceUpdatedAt=hint?.sourceUpdatedAt??null;result.conversations.set(native,value);const parentNative=agent?session:typeof row.parentSessionId==='string'?row.parentSessionId:null;if(parentNative&&!inventory.files.some(file=>file.stem===parentNative))result.gaps.push(gap('missing_segment',`unresolved_parent:${native}`,value.id));}return result.conversations.get(native);
  }
  try{
   abort(signal);const stat=await lstat(file.path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>cap.maxFileBytes)throw new Error('file_bound');
   // Opened content is bounded and checked again after reading; no index path is followed.
   const resolvedPath=await realpath(file.path);if(resolvedPath!==file.path)throw new Error('scope_changed');const raw=await boundedFile(file.path,cap.maxFileBytes,signal);if(raw.length>cap.maxFileBytes)throw new Error('file_bound');result.digest=sha256(raw);
   rawObject=await stageBytes(raw,'segment',file.native,signal);
   const events=readJsonl((async function*(){yield raw;})(),{signal,maxBytes:cap.maxFileBytes,maxLineBytes:cap.maxLineBytes,maxRecords:cap.maxRecords,maxDepth:40,allowPartialFinalLine:true});
   for await(const event of events){abort(signal);if(event.kind==='gap'){result.gaps.push(gap(event.code?.includes('partial')?'truncated_content':'parse',`reader_${event.code??'invalid'}:${file.native}:${event.line??0}`,getConversation().id));continue;}
    const row=event.value;if(!row||typeof row!=='object'||Array.isArray(row)){result.gaps.push(gap('parse',`unknown_record:${file.native}:${event.line}`,getConversation().id));continue;}
    const thread=getConversation(row),role=row.type==='user'?'user':row.type==='assistant'?'assistant':['system','summary'].includes(row.type)?'system':null;
    if(!role){result.gaps.push(gap('parse',`unsupported_record:${file.native}:${event.line}`,thread.id));continue;}
    const blocks=row.type==='summary'?row.summary:row.message?.content??row.content??(row.subtype==='compact_boundary'?'Compaction boundary':undefined);
    const text=[],attachments=[];let unknown=false;
    const append=(content,depth=0)=>{if(depth>20){unknown=true;return;}if(typeof content==='string'){text.push(content);return;}if(Array.isArray(content)){for(const block of content)append(block,depth+1);return;}if(!content||typeof content!=='object'){unknown=true;return;}
     if(content.type==='text'&&typeof content.text==='string')text.push(content.text);
     else if(content.type==='thinking'&&typeof content.thinking==='string')text.push(content.thinking);
     else if(content.type==='tool_result'){append(content.content,depth+1);}
     else if(content.type==='tool_use'&&typeof content.name==='string')text.push(JSON.stringify({type:'tool_use',id:content.id??null,name:content.name,input:content.input??null}));
     else if(['image','document','file'].includes(content.type)){attachments.push(content);}
     else unknown=true;
    };
    append(blocks);for(const block of attachments)text.push(JSON.stringify({attachment:block.type,name:typeof block.name==='string'?basename(block.name):null,sourceDigest:sha256(JSON.stringify(block.source??{}))}));const normalized=normalizeText(text.join('\n')),bytes=encoder.encode(normalized),digest=sha256(bytes),nativeMessageId=safeNative(row.uuid,`location:${file.native}:${event.line}`),revisionKey=thread.id+'\0'+nativeMessageId+'\0'+digest;
    if(unknown)result.gaps.push(gap('parse',`unsupported_content:${file.native}:${event.line}`,thread.id));
    if(result.seen.has(revisionKey))continue;result.seen.add(revisionKey);
    if(bytes.length>cap.maxMessageBytes){result.gaps.push(gap('truncated_content',`message_bound:${file.native}:${event.line}`,thread.id));continue;}
    const stored=await stageBytes(bytes,'message',nativeMessageId,signal),messageId=id('message',thread.id,nativeMessageId,digest),toolRole=role==='user'&&Array.isArray(blocks)&&blocks.length&&blocks.every(block=>block?.type==='tool_result')?'tool':role;
    result.messages.push({id:messageId,conversationId:thread.id,nativeMessageId,revisionDigest:digest,normalizationVersion:configuration.normalizationVersion??'unicode-nfc-lf-v1',parentNativeMessageId:typeof row.parentUuid==='string'&&row.parentUuid.length<=512?row.parentUuid:null,sequence:event.line-1,role:toolRole,occurredAt:timestamp(row.timestamp??row.message?.timestamp),observedAt,bodyObjectKey:stored.key,contentBytes:bytes.length,availability:unknown?'partial':'complete'});
    for(const [index,block]of attachments.entries()){
     const source=block.source??{},attachment={id:id('attachment',messageId,String(index)),messageRevisionId:messageId,nativeAttachmentId:typeof block.id==='string'?block.id:null,name:typeof block.name==='string'?basename(block.name).slice(0,200):`${block.type}-${index+1}`,mediaType:typeof source.media_type==='string'?source.media_type.slice(0,255):null,sha256:null,bytes:null,objectKey:null,availability:'unavailable',unavailableReason:'Referenced attachment bytes are unavailable.'};
     if(source.type==='base64'&&typeof source.data==='string'&&source.data.length<=Math.ceil(cap.maxAttachmentBytes/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)){
      const data=new Uint8Array(Buffer.from(source.data,'base64'));if(data.length<=cap.maxAttachmentBytes){const object=await stageBytes(data,'attachment',attachment.id,signal);Object.assign(attachment,{sha256:object.sha256,bytes:object.bytes,objectKey:object.key,availability:'complete',unavailableReason:null});}
     }
     if(attachment.availability!=='complete')result.gaps.push(gap('attachment',`unavailable_attachment:${file.native}:${event.line}:${index}`,thread.id));result.attachments.push(attachment);
    }
   }
   if(!result.conversations.size)getConversation();
   for(const thread of result.conversations.values())result.segments.push({id:id('segment',file.native,thread.id,result.digest),sourceId,conversationId:thread.id,nativeSegmentId:file.native,inheritedFromSegmentId:null,inheritedRange:null,sha256:rawObject.sha256,bytes:rawObject.bytes,objectKey:rawObject.key,availability:'complete',unavailableReason:null});
  }catch(error){abort(signal);if(error instanceof AssetStagingError)throw error;const thread=result.conversations.values().next().value??getConversation();result.gaps.push(gap('access',`unreadable_transcript:${file.native}`,thread.id));thread.availability=result.messages.length?'partial':'unavailable';if(rawObject){for(const value of result.conversations.values())result.segments.push({id:id('segment',file.native,value.id,result.digest),sourceId,conversationId:value.id,nativeSegmentId:file.native,inheritedFromSegmentId:null,inheritedRange:null,sha256:rawObject.sha256,bytes:rawObject.bytes,objectKey:rawObject.key,availability:'complete',unavailableReason:null});}else result.segments.push({id:id('segment',file.native,thread.id),sourceId,conversationId:thread.id,nativeSegmentId:file.native,inheritedFromSegmentId:null,inheritedRange:null,sha256:null,bytes:null,objectKey:null,availability:'unavailable',unavailableReason:'Transcript could not be read within configured bounds.'});}
  for(const thread of result.conversations.values())if(result.gaps.some(value=>value.conversationId===thread.id)&&thread.availability!=='unavailable')thread.availability='partial';
  parsedFiles.set(file.native,result);return result;
 }
 return {
  async capability(){return {sourceId,kind:'claude_code_local',scopeLabel,inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Configured local reader is implemented; private retained inventory and unattended operation require separate verification.'};},
  async readPage(cursor,signal){abort(signal);inventory??=await inspect(signal);let position={file:0,offset:0};if(cursor!==null){try{position=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(position.fingerprint!==inventory.fingerprint||!Number.isSafeInteger(position.file)||position.file<0||!Number.isSafeInteger(position.offset)||position.offset<0)throw new Error();}catch{throw new Error('Invalid or stale Claude Code local cursor.');}}
   const seenHints=Buffer.alloc(Math.ceil(inventory.hints.length/8));if(position.seenHints){const stored=Buffer.from(position.seenHints,'base64url');if(stored.length!==seenHints.length)throw new Error('Invalid Claude Code hint cursor.');stored.copy(seenHints);}
   const pageNativeIds=new Set();
   const page={codecVersion:1,sourceId,runId,pageId:'',previousCursor:cursor,nextCursor:null,inventoryExhausted:false,conversations:[],messages:[],segments:[],attachments:[],gaps:[],objectManifest:[]};
   if(position.file<inventory.files.length){const file=inventory.files[position.file],result=await parseFile(file,signal);if(position.digest&&position.digest!==result.digest)throw new Error('Transcript changed; start a new collection run.');page.conversations=structuredClone([...result.conversations.values()]);for(const thread of page.conversations)pageNativeIds.add(thread.nativeThreadId);page.messages=structuredClone(result.messages.slice(position.offset,position.offset+cap.pageMessages));const messageIds=new Set(page.messages.map(message=>message.id));page.attachments=structuredClone(result.attachments.filter(attachment=>messageIds.has(attachment.messageRevisionId)));page.segments=structuredClone(result.segments);page.gaps=position.offset===0?result.gaps.slice(0,cap.maxGaps):[];if(position.offset===0&&result.gaps.length>cap.maxGaps)page.gaps.push(gap('parse',`additional_${result.gaps.length-cap.maxGaps}_diagnostics`));
    const nextOffset=position.offset+page.messages.length;position=nextOffset<result.messages.length?{file:position.file,offset:nextOffset,digest:result.digest}:{file:position.file+1,offset:0};
   }else if(position.file===inventory.files.length){
    
    const unavailableHints=inventory.hints.filter((hint,index)=>!(seenHints[index>>3]&(1<<(index%8)))&&!inventory.files.some(file=>file.stem===hint.sessionId));
    for(const hint of unavailableHints.slice(position.offset,position.offset+cap.maxConversations)){
     const thread=conversation(hint.sessionId,hint.title);Object.assign(thread,{createdAt:hint.createdAt,sourceUpdatedAt:hint.sourceUpdatedAt,availability:'unavailable'});page.conversations.push(thread);page.gaps.push(gap('missing_transcript',`index_only:${hint.sessionId}`,thread.id));
    }
    if(position.offset===0)page.gaps.push(...inventory.gaps);
    const nextOffset=position.offset+page.conversations.length;position=nextOffset<unavailableHints.length?{file:position.file,offset:nextOffset}:{file:position.file+1,offset:0};
   }else throw new Error('Claude Code local cursor is past inventory.');
   const manifests=new Map(),mapping=new Map();
   const wanted=new Set([...page.messages.map(message=>message.bodyObjectKey),...page.segments.map(segment=>segment.objectKey),...page.attachments.map(attachment=>attachment.objectKey)].filter(Boolean));
   for(const object of staged.values())if(wanted.has(object.key)){
    abort(signal);let finalized;try{finalized=await stage({bytes:object.data,sha256:object.sha256,kind:object.kind,nativeId:object.nativeId,signal});}catch(error){abort(signal);throw new AssetStagingError('Local history asset staging failed; retry the page.',{cause:error});}
    abort(signal);if(!finalized||typeof finalized.key!=='string'||!finalized.key||finalized.sha256!==object.sha256||finalized.bytes!==object.bytes)throw new AssetStagingError('Staging port returned inconsistent object metadata.');
    mapping.set(object.key,finalized.key);manifests.set(finalized.key,{key:finalized.key,sha256:finalized.sha256,bytes:finalized.bytes});
   }
   for(const message of page.messages)message.bodyObjectKey=mapping.get(message.bodyObjectKey)??message.bodyObjectKey;
   for(const row of [...page.segments,...page.attachments])if(row.objectKey)row.objectKey=mapping.get(row.objectKey)??row.objectKey;
   page.objectManifest=[...manifests.values()];
   for(const [index,hint]of inventory.hints.entries())if(pageNativeIds.has(hint.sessionId))seenHints[index>>3]|=1<<(index%8);position.seenHints=seenHints.toString('base64url');
   page.nextCursor=position.file<=inventory.files.length?Buffer.from(JSON.stringify({...position,fingerprint:inventory.fingerprint})).toString('base64url'):null;page.inventoryExhausted=page.nextCursor===null&&inventory.exhausted;page.pageId=id('page',runId,cursor??'initial',sha256(JSON.stringify(page)));abort(signal);return page;
  }
 };
}
