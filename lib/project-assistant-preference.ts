type Assistant='codex'|'claude';
interface AssistantMemory {
 policies?:readonly {projectId:string;provider:Assistant}[];
 jobs?:readonly {kind:string;projectId?:string;provider?:Assistant;createdAt:string}[];
}
interface SavedAssistant {projectId:string;recordedAt:string;briefing:{run:{provider:Assistant}}}
/** Reuse the app's project policy preference, then the newest recorded briefing choice. */
export function rememberedProjectAssistant(projectId:string,connector:AssistantMemory,saved:readonly SavedAssistant[]=[]):Assistant|null{
 const policy=connector.policies?.find(row=>row.projectId===projectId);if(policy)return policy.provider;
 const job=connector.jobs?.filter(row=>row.kind==='brief'&&row.projectId===projectId&&row.provider).sort((left,right)=>Date.parse(right.createdAt)-Date.parse(left.createdAt))[0];
 if(job?.provider)return job.provider;
 return saved.filter(row=>row.projectId===projectId).sort((left,right)=>Date.parse(right.recordedAt)-Date.parse(left.recordedAt))[0]?.briefing.run.provider??null;
}
/** Optional preference recovery never blocks folder actions or replaces a fresh owner choice. */
export async function restoreProjectAssistant(options:{projectId:string;connector:AssistantMemory;signal:AbortSignal;hasOwnerChoice:()=>boolean;readSaved:(signal:AbortSignal)=>Promise<readonly SavedAssistant[]>;apply:(assistant:Assistant)=>void}):Promise<void>{
 if(options.signal.aborted||options.hasOwnerChoice())return;
 let remembered=rememberedProjectAssistant(options.projectId,options.connector);
 if(!remembered)remembered=rememberedProjectAssistant(options.projectId,options.connector,await options.readSaved(options.signal));
 if(remembered&&!options.signal.aborted&&!options.hasOwnerChoice())options.apply(remembered);
}
