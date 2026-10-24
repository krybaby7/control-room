/** Shared browser/server/companion contract for a project briefing: a plain-language
 * status report written for the owner from bounded evidence (recent local and cloud
 * repository work, the owner's own chat turns, recent local chats, the owner's own plan
 * and the previous briefing). Version 2 is an intention ledger: what the owner set out
 * to do, whether each aim was reached, where the plan bent, and a map of the project's
 * areas. The report carries no execution authority: nothing in it accepts, completes,
 * approves or spends. Version 1 reports still validate and are projected to version 2. */
export const PROJECT_BRIEFING_MARKER='control-room-project-briefing-v1';
export const PROJECT_BRIEFING_VERSION=2;
/** Briefing statements may exceed the ordinary evidence statement bound; the evidence
 * validator allows this many characters for the briefing marker only. The companion and
 * the personal channel keep the stricter 55,000-byte delivery bound. */
export const PROJECT_BRIEFING_MAX_CHARACTERS=26000;
export const COMPACT_PLAN_MAX_CHARACTERS=6000;
export const BRIEFING_PROVIDERS=Object.freeze(['codex','claude']);
export const BRIEFING_MODELS=Object.freeze({codex:'gpt-6.1-sol',claude:'claude-code-default'});
export const BRIEFING_STATUS_LEVELS=Object.freeze(['on-track','at-risk','blocked','paused','unclear']);
export const BRIEFING_WORK_OUTCOMES=Object.freeze(['finished','unfinished','unclear']);
export const BRIEFING_WORK_PLACES=Object.freeze(['local','cloud','both','chat']);
/** How far an area of the project has been proven. */
export const BRIEFING_AREA_STATES=Object.freeze(['proven','built','partial','open','paused','blocked','none']);
/** What became of one of the owner's intentions. */
export const BRIEFING_INTENTION_STATES=Object.freeze(['reached','negative','changed','paused','not-reached','in-progress','open']);
/** Where the intention was read from. */
export const BRIEFING_INTENTION_SOURCES=Object.freeze(['local-codex','local-claude','cloud','plan','repository','unknown']);
const str=(maxLength,minLength=1)=>({type:'string',minLength,maxLength});
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items,maxItems)=>({type:'array',items,maxItems});
const nullable=schema=>({anyOf:[schema,{const:null}]});
const enumeration=values=>({enum:[...values]});
const digest={...str(64,64),pattern:'^[a-f0-9]{64}$'};
const uuid={...str(36,36),pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'};
const isoDate={...str(10,10),pattern:'^\\d{4}-\\d\\d-\\d\\d$'};
const stamp={...str(40,20),pattern:'^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d{1,3})?Z$'};
const slug={...str(40),pattern:'^[a-z][a-z0-9-]{0,39}$'};
/** Version 1 content, kept so saved reports still validate. */
export const briefingContentSchemaV1=object({
 headline:str(240),
 status:object({level:enumeration(BRIEFING_STATUS_LEVELS),reason:str(240)}),
 recentWork:array(object({title:str(120),outcome:enumeration(BRIEFING_WORK_OUTCOMES),when:nullable(isoDate),where:enumeration(BRIEFING_WORK_PLACES),detail:str(240),evidence:array(str(60),3)}),8),
 unfinished:array(object({title:str(120),remaining:str(240),where:enumeration(BRIEFING_WORK_PLACES)}),5),
 done:array(str(160),8),
 notDone:array(str(160),8),
 decisionsNeeded:array(str(200),4),
 nextSteps:array(str(160),5),
 limitations:array(str(200),5),
});
/** The part the model writes (version 2). Everything here is owner-facing prose plus bounded evidence refs.
 * `areas` and `links` draw the project map; `intentions` is the ledger, newest first; a `bend` marks a
 * point where the owner changed the plan. */
export const briefingContentSchema=object({
 aim:str(240),
 status:object({level:enumeration(BRIEFING_STATUS_LEVELS),reason:str(240)}),
 leftOff:array(str(420),4),
 areas:array(object({id:slug,name:str(60),state:enumeration(BRIEFING_AREA_STATES),done:integer(0,999),total:integer(0,999),note:str(90)}),12),
 links:array(object({from:slug,to:slug}),24),
 aimArea:nullable(slug),
 intentions:array(object({date:nullable(isoDate),title:str(160),outcome:str(320),state:enumeration(BRIEFING_INTENTION_STATES),source:enumeration(BRIEFING_INTENTION_SOURCES),area:nullable(slug),bend:nullable(object({from:str(200),to:str(200),why:str(240)})),evidence:array(str(60),3)}),24),
 open:array(str(240),6),
 needsYou:array(str(240),5),
 tried:array(str(200),8),
 done:array(str(160),8),
 notDone:array(str(160),8),
 nextSteps:array(str(160),5),
 limitations:array(str(200),5),
});
const chatProvider=enumeration(BRIEFING_PROVIDERS);
const evidenceProperties={
 window:object({since:stamp,until:stamp}),
 local:object({branch:nullable(str(200)),commits:integer(0,1000),branches:integer(0,500),latestCommitAt:nullable(stamp),uncommittedFiles:integer(0,100000)}),
 cloud:object({status:enumeration(['fetched','stale','unavailable','no-remote']),remote:nullable(str(200)),branches:integer(0,500),commits:integer(0,1000),latestCommitAt:nullable(stamp),pullRequests:nullable(integer(0,1000)),openPullRequests:nullable(integer(0,1000)),fetchedAt:nullable(stamp)}),
 chats:array(object({provider:chatProvider,status:enumeration(['included','not-found','unavailable']),sessions:integer(0,10),messages:integer(0,200),latestAt:nullable(stamp)}),2),
 plan:nullable(object({revision:integer(0,Number.MAX_SAFE_INTEGER),milestones:integer(0,1000),tasks:integer(0,10000)})),
 inputSha256:digest,
};
export const briefingEvidenceSchemaV1=object(evidenceProperties);
/** Version 2 adds the owner's own chat turns and the previous briefing the ledger was carried forward from. */
export const briefingEvidenceSchema=object({
 ...evidenceProperties,
 ownerTurns:object({sessions:integer(0,64),turns:integer(0,1000),characters:integer(0,200000),earliestAt:nullable(stamp),latestAt:nullable(stamp)}),
 previous:nullable(object({runId:uuid,until:stamp,intentions:integer(0,24)})),
});
const identityProperties={
 project:object({id:{...str(128),pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'},name:str(200)}),
 repository:object({key:{...str(128),pattern:'^[a-zA-Z0-9_-]+$'},name:str(100),head:{...str(64,40),pattern:'^(?:[a-f0-9]{40}|[a-f0-9]{64})$'},branch:nullable(str(200)),dirty:{type:'boolean'}}),
 run:object({id:uuid,provider:chatProvider,requestedModel:enumeration(Object.values(BRIEFING_MODELS)),observedModel:nullable({...str(120),pattern:'^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$'}),startedAt:stamp,completedAt:stamp,mode:{const:'read-only'},source:{const:'personal-pc-connector'},origin:enumeration(['owner','auto'])}),
};
export const projectBriefingSchemaV1=object({format:{const:'control-room-project-briefing'},version:{const:1},...identityProperties,evidence:briefingEvidenceSchemaV1,...briefingContentSchemaV1.properties});
export const projectBriefingSchema=object({format:{const:'control-room-project-briefing'},version:{const:2},...identityProperties,evidence:briefingEvidenceSchema,...briefingContentSchema.properties});
/** Bounded projection of the owner's own plan that travels with a briefing request. */
export const compactPlanSchema=object({
 revision:integer(0,Number.MAX_SAFE_INTEGER),
 project:object({id:{...str(128),pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'},name:str(200),goal:str(400,0),description:str(300,0)}),
 milestones:array(object({title:str(120),status:enumeration(['planned','active','achieved']),targetDate:nullable(isoDate)}),12),
 tasks:array(object({title:str(120),status:enumeration(['proposed','todo','doing','review','done']),horizon:enumeration(['now','next','later']),dueDate:nullable(isoDate),milestone:nullable(integer(0,11)),blocked:{type:'boolean'},completedAt:nullable(isoDate)}),40),
 totals:object({tasks:integer(0,100000),open:integer(0,100000),done:integer(0,100000),omitted:integer(0,100000)}),
});
/** The bounded slice of a previous briefing that rides into the next run so the ledger carries forward. */
export const PREVIOUS_LEDGER_MAX_CHARACTERS=14000;
export const previousLedgerSchema=object({
 runId:uuid,until:stamp,aim:str(240),
 areas:briefingContentSchema.properties.areas,links:briefingContentSchema.properties.links,aimArea:nullable(slug),
 intentions:briefingContentSchema.properties.intentions,
 open:briefingContentSchema.properties.open,needsYou:briefingContentSchema.properties.needsYou,
});
function invalid(path){throw new Error(`Invalid project briefing${path?` at ${path}`:''}.`);}
function check(schema,value,path=''){
 if(schema.anyOf){if(!schema.anyOf.some(option=>{try{check(option,value,path);return true;}catch{return false;}}))invalid(path);return;}
 if(Object.hasOwn(schema,'const')&&value!==schema.const)invalid(path);
 if(schema.enum&&!schema.enum.includes(value))invalid(path);
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid(path);
  const keys=Object.keys(value);if(schema.required.some(key=>!Object.hasOwn(value,key))||keys.some(key=>!Object.hasOwn(schema.properties,key)))invalid(path);
  for(const key of keys)check(schema.properties[key],value[key],path?`${path}.${key}`:key);
 }
 if(schema.type==='array'){
  if(!Array.isArray(value)||value.length>schema.maxItems)invalid(path);
  value.forEach((item,i)=>check(schema.items,item,`${path}.${i}`));
 }
 if(schema.type==='string'&&(typeof value!=='string'||value.length<schema.minLength||value.length>schema.maxLength||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)||schema.minLength>0&&!value.trim()||schema.pattern&&!new RegExp(schema.pattern,'u').test(value)))invalid(path);
 if(schema.type==='integer'&&(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum))invalid(path);
 if(schema.type==='boolean'&&typeof value!=='boolean')invalid(path);
}
const validTime=time=>typeof time==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(time)&&Number.isFinite(Date.parse(time))&&new Date(time).toISOString().slice(0,10)===time.slice(0,10);
const validDate=date=>date===null||/^\d{4}-\d\d-\d\d$/u.test(date)&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
function clone(value){return JSON.parse(JSON.stringify(value));}
/** The map must be a one-way flow: every link names two different known areas and no cycle exists. */
function checkMap(value,path){
 const ids=value.areas.map(area=>area.id);
 if(new Set(ids).size!==ids.length)invalid(path+'areas');
 const known=new Set(ids);
 if(value.aimArea!==null&&!known.has(value.aimArea))invalid(path+'aimArea');
 const seen=new Set();
 for(const link of value.links){const key=link.from+'>'+link.to;if(link.from===link.to||!known.has(link.from)||!known.has(link.to)||seen.has(key))invalid(path+'links');seen.add(key);}
 const next=new Map(ids.map(id=>[id,[]]));for(const link of value.links)next.get(link.from).push(link.to);
 const state=new Map();
 const visit=id=>{if(state.get(id)===1)invalid(path+'links');if(state.get(id)===2)return;state.set(id,1);for(const to of next.get(id))visit(to);state.set(id,2);};
 for(const id of ids)visit(id);
 for(const [i,row] of value.intentions.entries())if(row.area!==null&&!known.has(row.area))invalid(`${path}intentions.${i}.area`);
}
function checkIntentionDates(value,path){
 for(const [i,row] of value.intentions.entries())if(!validDate(row.date))invalid(`${path}intentions.${i}.date`);
}
/** Validates what the model returned (version 2); the companion adds identity and evidence around it. */
export function validateBriefingContent(value){
 check(briefingContentSchema,value);
 checkMap(value,'');checkIntentionDates(value,'');
 return clone(value);
}
export function validateBriefingContentV1(value){
 check(briefingContentSchemaV1,value);
 for(const row of value.recentWork)if(!validDate(row.when))invalid('recentWork.when');
 return clone(value);
}
function checkEvidenceTimes(e){
 for(const time of [e.window.since,e.window.until,e.local.latestCommitAt,e.cloud.latestCommitAt,e.cloud.fetchedAt,...e.chats.map(chat=>chat.latestAt)])if(time!==null&&!validTime(time))invalid('evidence time');
 if(Date.parse(e.window.until)<Date.parse(e.window.since))invalid('evidence window');
 if(new Set(e.chats.map(chat=>chat.provider)).size!==e.chats.length)invalid('evidence chats');
 for(const chat of e.chats)if(chat.status==='included'?(chat.sessions===0||chat.messages===0||chat.latestAt===null):(chat.sessions!==0||chat.messages!==0))invalid('evidence chat coverage');
 if(e.cloud.status==='no-remote'&&(e.cloud.remote!==null||e.cloud.branches||e.cloud.commits||e.cloud.pullRequests!==null))invalid('evidence cloud');
 if(e.cloud.status==='fetched'&&e.cloud.fetchedAt===null)invalid('evidence cloud fetch');
 if(e.cloud.openPullRequests!==null&&(e.cloud.pullRequests===null||e.cloud.openPullRequests>e.cloud.pullRequests))invalid('evidence pull requests');
}
export function validateBriefingEvidence(value){
 check(briefingEvidenceSchema,value);
 checkEvidenceTimes(value);
 const turns=value.ownerTurns;
 for(const time of [turns.earliestAt,turns.latestAt])if(time!==null&&!validTime(time))invalid('evidence owner turns');
 if(turns.turns===0?(turns.sessions!==0||turns.characters!==0||turns.earliestAt!==null||turns.latestAt!==null):(turns.sessions===0||turns.characters===0||turns.latestAt===null||turns.earliestAt===null||Date.parse(turns.latestAt)<Date.parse(turns.earliestAt)))invalid('evidence owner turns');
 if(value.previous!==null&&(!validTime(value.previous.until)||Date.parse(value.previous.until)>Date.parse(value.window.until)))invalid('evidence previous');
 return clone(value);
}
export function validateBriefingEvidenceV1(value){
 check(briefingEvidenceSchemaV1,value);
 checkEvidenceTimes(value);
 return clone(value);
}
const V1_STATE={finished:'reached',unfinished:'in-progress',unclear:'open'};
const V1_SOURCE={local:'repository',cloud:'repository',both:'repository',chat:'unknown'};
const cut=(text,max)=>text.length>max?text.slice(0,max-1).trimEnd()+'…':text;
/** A saved version 1 report shown through the version 2 shape: the headline becomes the aim, recent work
 * becomes the ledger, decisions become what needs the owner. The map stays empty because version 1 never
 * described areas. The projection is pure and is not written back. */
export function upgradeBriefing(v1){
 const content={
  aim:v1.headline,status:v1.status,leftOff:[v1.status.reason],areas:[],links:[],aimArea:null,
  intentions:v1.recentWork.map(row=>({date:row.when,title:cut(row.title,160),outcome:cut(row.detail,320),state:V1_STATE[row.outcome],source:V1_SOURCE[row.where],area:null,bend:null,evidence:row.evidence})),
  open:v1.unfinished.map(row=>cut(`${row.title}: ${row.remaining}`,240)).slice(0,6),
  needsYou:v1.decisionsNeeded.map(text=>cut(text,240)).slice(0,5),tried:[],
  done:v1.done,notDone:v1.notDone,nextSteps:v1.nextSteps,limitations:v1.limitations,
 };
 const evidence={...v1.evidence,ownerTurns:{sessions:0,turns:0,characters:0,earliestAt:null,latestAt:null},previous:null};
 return {format:v1.format,version:2,project:v1.project,repository:v1.repository,run:v1.run,evidence,...content};
}
function checkRun(value){
 if(value.run.requestedModel!==BRIEFING_MODELS[value.run.provider])invalid('run provider model');
 if(value.run.provider==='codex'?(value.run.observedModel!==null&&value.run.observedModel!=='gpt-6.1-sol'):(value.run.observedModel!==null&&!/^claude[-._/]/u.test(value.run.observedModel)))invalid('run observed model');
 for(const time of [value.run.startedAt,value.run.completedAt])if(!validTime(time))invalid('run time');
 if(Date.parse(value.run.completedAt)<Date.parse(value.run.startedAt))invalid('run time order');
}
const contentOf=(schema,value)=>Object.fromEntries(Object.keys(schema.properties).map(key=>[key,value[key]]));
/** Validates a complete report of either version and returns it in the version 2 shape. */
export function validateProjectBriefing(value){
 if(value&&typeof value==='object'&&value.version===1){
  check(projectBriefingSchemaV1,value);
  checkRun(value);
  validateBriefingEvidenceV1(value.evidence);
  validateBriefingContentV1(contentOf(briefingContentSchemaV1,value));
  const serialized=JSON.stringify(value);
  if(serialized.length>PROJECT_BRIEFING_MAX_CHARACTERS||new TextEncoder().encode(serialized).length>55000)invalid('report size');
  return upgradeBriefing(JSON.parse(serialized));
 }
 check(projectBriefingSchema,value);
 checkRun(value);
 validateBriefingEvidence(value.evidence);
 validateBriefingContent(contentOf(briefingContentSchema,value));
 if(value.evidence.previous!==null&&value.evidence.previous.runId===value.run.id)invalid('evidence previous run');
 const serialized=JSON.stringify(value);
 if(serialized.length>PROJECT_BRIEFING_MAX_CHARACTERS||new TextEncoder().encode(serialized).length>55000)invalid('report size');
 return JSON.parse(serialized);
}
/** The slice of a validated report that the next run receives. Pure and bounded: intentions are dropped
 * oldest first until the slice fits. */
export function previousLedger(briefing){
 const report=validateProjectBriefing(briefing);
 const slice={runId:report.run.id,until:report.evidence.window.until,aim:report.aim,areas:report.areas,links:report.links,aimArea:report.aimArea,intentions:report.intentions,open:report.open,needsYou:report.needsYou};
 while(JSON.stringify(slice).length>PREVIOUS_LEDGER_MAX_CHARACTERS&&slice.intentions.length)slice.intentions=slice.intentions.slice(0,-1);
 return validatePreviousLedger(slice);
}
export function validatePreviousLedger(value){
 check(previousLedgerSchema,value);
 if(!validTime(value.until))invalid('previous until');
 checkMap(value,'previous.');checkIntentionDates(value,'previous.');
 if(JSON.stringify(value).length>PREVIOUS_LEDGER_MAX_CHARACTERS)invalid('previous size');
 return clone(value);
}
export function validateCompactPlan(value){
 check(compactPlanSchema,value);
 for(const row of value.milestones)if(!validDate(row.targetDate))invalid('plan milestone date');
 for(const row of value.tasks){if(!validDate(row.dueDate)||!validDate(row.completedAt))invalid('plan task date');if(row.milestone!==null&&row.milestone>=value.milestones.length)invalid('plan task milestone');}
 if(JSON.stringify(value).length>COMPACT_PLAN_MAX_CHARACTERS)invalid('plan size');
 return clone(value);
}
const trim=(text,max)=>{const value=String(text??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'').replace(/\s+/gu,' ').trim();return value.length>max?value.slice(0,max-1).trimEnd()+'…':value;};
const day=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\d/u.test(value)?value.slice(0,10):null;
/** Pure, bounded projection of the owner's saved plan for one project. Open work first, then the
 * most recently completed tasks; everything is truncated so the plan always fits its budget. */
export function compactPlan(workspace,projectId,revision){
 const project=workspace.projects.find(row=>row.id===projectId);
 if(!project)throw new Error('Choose an active project.');
 const milestoneRows=workspace.milestones.filter(row=>row.projectId===projectId&&!row.archivedAt).sort((a,b)=>a.sortKey-b.sortKey||a.id.localeCompare(b.id));
 const order={active:0,planned:1,achieved:2};
 const kept=[...milestoneRows].sort((a,b)=>order[a.status]-order[b.status]||a.sortKey-b.sortKey).slice(0,12);
 const index=new Map(kept.map((row,i)=>[row.id,i]));
 const milestones=kept.map(row=>({title:trim(row.title,120)||'Untitled milestone',status:row.status,targetDate:day(row.targetDate)}));
 const tasks=workspace.tasks.filter(row=>row.projectId===projectId&&row.status!=='archived');
 const rank={doing:0,review:1,todo:2,proposed:3,done:4};
 const open=tasks.filter(row=>row.status!=='done').sort((a,b)=>rank[a.status]-rank[b.status]||Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
 const done=tasks.filter(row=>row.status==='done').sort((a,b)=>Date.parse(b.completedAt??b.updatedAt)-Date.parse(a.completedAt??a.updatedAt));
 const selected=[...open.slice(0,30),...done.slice(0,10)].slice(0,40);
 const toRow=row=>({title:trim(row.title,120)||'Untitled task',status:row.status,horizon:row.horizon,dueDate:day(row.dueDate),milestone:row.milestoneId!==null&&index.has(row.milestoneId)?index.get(row.milestoneId):null,blocked:Boolean(row.blocker&&row.blocker.trim())||row.dependsOn.some(id=>tasks.some(other=>other.id===id&&other.status!=='done')),completedAt:row.status==='done'?day(row.completedAt):null});
 const plan={revision:Number.isSafeInteger(revision)&&revision>=0?revision:0,project:{id:project.id,name:trim(project.name,200)||'Project',goal:trim(project.goal,400),description:trim(project.description,300)},milestones,tasks:selected.map(toRow),totals:{tasks:tasks.length,open:open.length,done:done.length,omitted:0}};
 while(JSON.stringify(plan).length>COMPACT_PLAN_MAX_CHARACTERS&&plan.tasks.length)plan.tasks.pop();
 plan.totals.omitted=tasks.length-plan.tasks.length;
 return validateCompactPlan(plan);
}
