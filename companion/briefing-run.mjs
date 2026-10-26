import {collectBriefingEvidence,collectProjectBriefingEvidence} from './briefing-evidence.mjs';
import {buildBriefingPrompt,BRIEFING_SYSTEM_PROMPT} from './briefing-prompt.mjs';
import {runCodexStructured} from './codex.mjs';
import {runClaudeStructured} from './claude.mjs';
import {withAnalysisSlot} from './analysis-run.mjs';
import {briefingContentSchema,validateBriefingContent,validateProjectFraming,validateProjectBriefing,validatePreviousLedger,PROJECT_BRIEFING_VERSION,BRIEFING_MODELS} from '../shared/project-briefing.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const defaultRunners={
 codex:({prompt,signal})=>runCodexStructured({prompt,schema:briefingContentSchema,signal}),
 claude:({prompt,signal})=>runClaudeStructured({prompt,schema:briefingContentSchema,systemPrompt:BRIEFING_SYSTEM_PROMPT,validate:validateBriefingContent,signal}),
};
/** One bounded briefing: evidence pack, one model call under the shared single slot, strict validation.
 * Returns the briefing plus the work fingerprint the evidence was taken at. */
export async function runProjectBriefing({root,repositories,requestId,provider,framing,origin='owner',previous=null},{signal,collect=collectBriefingEvidence,collectProject=collectProjectBriefingEvidence,runners=defaultRunners,now=()=>new Date().toISOString(),fetchRemote=true,codexHome,claudeHome}={}){
 if(!['codex','claude'].includes(provider)||!['owner','auto'].includes(origin)||(repositories===undefined&&typeof root!=='string')||!UUID.test(requestId))throw new Error('Invalid finite project briefing.');
 const checkedFraming=validateProjectFraming(framing),checkedPrevious=previous===null?null:validatePreviousLedger(previous);
 if(checkedPrevious&&checkedPrevious.runId===requestId)throw new Error('Invalid finite project briefing.');
 return withAnalysisSlot(async()=>{
  const deadline=AbortSignal.timeout(540000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;bounded.throwIfAborted();
  const startedAt=now(),options={signal:bounded,now,fetchRemote,codexHome,claudeHome,previous:checkedPrevious};
  let evidence;if(repositories!==undefined)evidence=await collectProject(repositories,options);else{evidence=await collect(root,options);if(!evidence.identities){evidence.identities=[{...evidence.identity,branch:evidence.branch}];evidence.summary.repositories=[{key:evidence.identity.key,name:evidence.identity.name,...Object.fromEntries(['local','cloud','chats','ownerTurns','cloudTurns'].filter(key=>evidence.summary[key]!==undefined).map(key=>[key,evidence.summary[key]]))}];}}
  const prompt=buildBriefingPrompt({bundle:evidence.bundle,framing:checkedFraming,previous:checkedPrevious});
  const result=await runners[provider]({prompt,signal:bounded});bounded.throwIfAborted();
  const content=validateBriefingContent(result.content);
  for(const row of content.intentions.filter(row=>row.source==='plan')){
   if(!checkedPrevious?.intentions.some(old=>old.source==='plan'&&old.title===row.title&&old.date===row.date))throw new Error('New intentions cannot come from framing or task records.');
  }
  let legacyCloud=false;
  for(const row of content.intentions.filter(row=>row.source==='cloud')){
   const carried=checkedPrevious?.intentions.some(old=>old.source==='cloud'&&old.title===row.title&&old.date===row.date&&old.cloudProvider===row.cloudProvider&&(old.repositoryKey===row.repositoryKey||row.repositoryKey===undefined&&old.repositoryKey&&!evidence.identities.some(identity=>identity.key===old.repositoryKey)));
   const read=row.cloudProvider&&evidence.bundle.ownerTurns?.some(session=>session.source==='cloud'&&session.provider===row.cloudProvider&&(!row.repositoryKey||session.repositoryKey===row.repositoryKey)&&session.turns?.length);
   if(!carried&&!read)throw new Error('Cloud intention has no matching owner-turn source.');
   legacyCloud||=!row.cloudProvider;
  }
  content.limitations=[...content.limitations.slice(0,legacyCloud?2:3),...(legacyCloud?['An older cloud intention was carried forward; its original assistant was not recorded.']:[]),'Written from your own chat turns, recent commits, branches, pull requests and chat excerpts; nothing was run or tested.','Model statements are claims for the owner to weigh, not verified facts.'].slice(0,5);
  if(provider==='codex'&&result.observedModel&&result.observedModel!=='gpt-6.1-sol')throw new Error('Observed model differs from requested model.');
  const briefing=validateProjectBriefing({format:'control-room-project-briefing',version:PROJECT_BRIEFING_VERSION,project:{id:checkedFraming.projectId,name:checkedFraming.projectName},repository:{key:evidence.identity.key,name:evidence.identity.name,head:evidence.identity.head,branch:evidence.branch,dirty:evidence.identity.dirty},repositories:evidence.identities.map(identity=>({key:identity.key,name:identity.name,head:identity.head,branch:identity.branch,dirty:identity.dirty})),run:{id:requestId,provider,requestedModel:BRIEFING_MODELS[provider],observedModel:result.observedModel??null,startedAt,completedAt:now(),mode:'read-only',source:'personal-pc-connector',origin},evidence:{...Object.fromEntries(Object.entries(evidence.summary).filter(([key])=>key!=='plan')),framing:{workspaceRevision:checkedFraming.workspaceRevision,characters:checkedFraming.framing.length,includeTaskPlan:checkedFraming.includeTaskPlan,totalMilestones:checkedFraming.totalMilestones,totalTasks:checkedFraming.totalTasks,includedMilestones:checkedFraming.milestones.length,includedTasks:checkedFraming.tasks.length}},...content});
  return {briefing,fingerprint:evidence.fingerprint};
 });
}
