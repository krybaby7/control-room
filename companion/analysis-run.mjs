import {snapshotRepository,analysisBundle} from './snapshot.mjs';
import {collectProjectChats} from './chat-context.mjs';
import {validateChatInput} from './analysis-prompt.mjs';
import {analyzeWithCodex} from './codex.mjs';
import {analyzeWithClaude} from './claude.mjs';
import {validateReportContent,validateLocalAnalysis} from '../shared/local-analysis.mjs';
let occupied=false,blocked=false;
export function analysisSlotStatus(){return {occupied,blocked};}
export async function withAnalysisSlot(operation){if(occupied||blocked)throw new Error(blocked?'Local process inspection and companion restart are required.':'One analysis is already active.');occupied=true;try{return await operation();}catch(error){if(error?.code==='owned_exit_unconfirmed')blocked=true;throw error;}finally{occupied=false;}}
export async function runRepositoryAnalysis({root,requestId,provider,source='personal-pc-connector'},{signal,snapshot=snapshotRepository,collectChats=collectProjectChats,analyzers={codex:analyzeWithCodex,claude:analyzeWithClaude},now=()=>new Date().toISOString()}={}){
 if(!['codex','claude'].includes(provider)||source!=='personal-pc-connector'||typeof root!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId))throw new Error('Invalid finite repository analysis.');
 return withAnalysisSlot(async()=>{const deadline=AbortSignal.timeout(300000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;bounded.throwIfAborted();const startedAt=now(),pack=await snapshot(root,{signal:bounded});const chatInput=validateChatInput(pack.sha256,await collectChats(root,{signal:bounded,snapshotSha256:pack.sha256}));const result=await analyzers[provider](pack,{signal:bounded,chatContext:chatInput?.context});bounded.throwIfAborted();const content=validateReportContent(result.content),bundle=analysisBundle(pack);
 content.limitations=[...content.limitations.slice(0,5),'Partial bounded source excerpts only; omitted files and unshown lines were not analyzed.','No project build or test commands were executed; runtime behavior was not verified.','Credential filtering is heuristic and cannot recognize every private value.'];
 for(const section of content.architecture)for(const path of section.paths)if(!bundle.excerpts.some(row=>row.path===path||row.path.startsWith(path+'/')))throw new Error('Unknown architecture path.');
 for(const finding of content.findings){const entry=bundle.excerpts.find(row=>row.path===finding.path);if(!entry||entry.sha256!==finding.sha256||finding.line<1||finding.line>entry.content.split('\n').length)throw new Error('Invalid source citation.');}
 if(provider==='codex'&&result.observedModel&&result.observedModel!=='gpt-6.1-sol')throw new Error('Observed model differs from requested model.');
 return validateLocalAnalysis({format:'control-room-project-analysis',version:1,repository:{key:pack.key,name:pack.name,head:pack.head,dirty:pack.dirty,snapshotSha256:pack.sha256,files:pack.entries.length,bytes:pack.bytes,includedChanges:true,excludedFiles:pack.excludedFiles},run:{id:requestId,provider,requestedModel:provider==='codex'?'gpt-6.1-sol':'claude-code-default',observedModel:result.observedModel??null,startedAt,completedAt:now(),mode:'read-only',source},...content,...(chatInput?{chatContext:chatInput.provenance}:{})});});
}
