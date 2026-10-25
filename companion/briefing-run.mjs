import {collectBriefingEvidence} from './briefing-evidence.mjs';
import {buildBriefingPrompt,BRIEFING_SYSTEM_PROMPT} from './briefing-prompt.mjs';
import {runCodexStructured} from './codex.mjs';
import {runClaudeStructured} from './claude.mjs';
import {withAnalysisSlot} from './analysis-run.mjs';
import {briefingContentSchema,validateBriefingContent,validateCompactPlan,validateProjectBriefing,validatePreviousLedger,PROJECT_BRIEFING_VERSION,BRIEFING_MODELS} from '../shared/project-briefing.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const defaultRunners={
 codex:({prompt,signal})=>runCodexStructured({prompt,schema:briefingContentSchema,signal}),
 claude:({prompt,signal})=>runClaudeStructured({prompt,schema:briefingContentSchema,systemPrompt:BRIEFING_SYSTEM_PROMPT,validate:validateBriefingContent,signal}),
};
/** One bounded briefing: evidence pack, one model call under the shared single slot, strict validation.
 * Returns the briefing plus the work fingerprint the evidence was taken at. */
export async function runProjectBriefing({root,requestId,provider,plan,origin='owner',previous=null},{signal,collect=collectBriefingEvidence,runners=defaultRunners,now=()=>new Date().toISOString(),fetchRemote=true,codexHome,claudeHome}={}){
 if(!['codex','claude'].includes(provider)||!['owner','auto'].includes(origin)||typeof root!=='string'||!UUID.test(requestId))throw new Error('Invalid finite project briefing.');
 const checkedPlan=validateCompactPlan(plan),checkedPrevious=previous===null?null:validatePreviousLedger(previous);
 if(checkedPrevious&&checkedPrevious.runId===requestId)throw new Error('Invalid finite project briefing.');
 return withAnalysisSlot(async()=>{
  const deadline=AbortSignal.timeout(540000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;bounded.throwIfAborted();
  const startedAt=now(),evidence=await collect(root,{signal:bounded,now,fetchRemote,codexHome,claudeHome,previous:checkedPrevious});
  const prompt=buildBriefingPrompt({bundle:evidence.bundle,plan:checkedPlan,projectName:checkedPlan.project.name,previous:checkedPrevious});
  const result=await runners[provider]({prompt,signal:bounded});bounded.throwIfAborted();
  const content=validateBriefingContent(result.content);
  let legacyCloud=false;
  for(const row of content.intentions.filter(row=>row.source==='cloud')){
   const carried=checkedPrevious?.intentions.some(old=>old.source==='cloud'&&old.title===row.title&&old.date===row.date&&old.cloudProvider===row.cloudProvider);
   const read=row.cloudProvider&&evidence.bundle.ownerTurns?.some(session=>session.source==='cloud'&&session.provider===row.cloudProvider&&session.turns?.length);
   if(!carried&&!read)throw new Error('Cloud intention has no matching owner-turn source.');
   legacyCloud||=!row.cloudProvider;
  }
  content.limitations=[...content.limitations.slice(0,legacyCloud?2:3),...(legacyCloud?['An older cloud intention was carried forward; its original assistant was not recorded.']:[]),'Written from your own chat turns, recent commits, branches, pull requests and chat excerpts; nothing was run or tested.','Model statements are claims for the owner to weigh, not verified facts.'].slice(0,5);
  if(provider==='codex'&&result.observedModel&&result.observedModel!=='gpt-6.1-sol')throw new Error('Observed model differs from requested model.');
  const briefing=validateProjectBriefing({format:'control-room-project-briefing',version:PROJECT_BRIEFING_VERSION,project:{id:checkedPlan.project.id,name:checkedPlan.project.name},repository:{key:evidence.identity.key,name:evidence.identity.name,head:evidence.identity.head,branch:evidence.branch,dirty:evidence.identity.dirty},run:{id:requestId,provider,requestedModel:BRIEFING_MODELS[provider],observedModel:result.observedModel??null,startedAt,completedAt:now(),mode:'read-only',source:'personal-pc-connector',origin},evidence:{...evidence.summary,plan:{revision:checkedPlan.revision,milestones:checkedPlan.milestones.length,tasks:checkedPlan.totals.tasks}},...content});
  return {briefing,fingerprint:evidence.fingerprint};
 });
}
