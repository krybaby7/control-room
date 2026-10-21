/** Shared browser/server/companion data contract. No execution authority is encoded. */
export const LOCAL_ANALYSIS_MARKER='control-room-local-analysis-v1';
export const LOCAL_ANALYSIS_MAX_CHARACTERS=9600;
const str=(maxLength,minLength=1)=>({type:'string',minLength,maxLength});
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items,maxItems)=>({type:'array',items,maxItems});
const digest={...str(64,64),pattern:'^[a-f0-9]{64}$'};
const relativePath={...str(500),pattern:'^[^/\\\\:\\u0000-\\u001f\\u007f]+(?:/[^/\\\\:\\u0000-\\u001f\\u007f]+)*$'};
const nullable=schema=>({anyOf:[schema,{const:null}]});
export const chatContextSchema=object({policy:{const:'latest-project-chats'},maxCharacters:{const:4000},includedCharacters:integer(0,4000),inputSha256:digest,cloud:{const:'not-connected'},sources:array(object({provider:{enum:['codex','claude']},status:{enum:['included','not-found','unavailable','filtered','deferred']},match:{enum:['cwd','git-identity',null]},latestAt:nullable(str(40)),messages:integer(0,6),characters:integer(0,2000),excerptSha256:nullable(digest),truncated:{type:'boolean'}}),2)});
// Optional strategy metadata leaves existing report serialization untouched.
chatContextSchema.properties.selection={const:'concise-user-first-v1'};
export const reportContentSchema=object({
 summary:str(1200),
 architecture:array(object({name:str(80),description:str(400),paths:array(relativePath,4)}),8),
 findings:array(object({path:relativePath,line:integer(1,1000000),sha256:digest,claim:str(400)}),12),
 suggestedTasks:array(object({title:str(160),notes:str(400,0)}),6),
 limitations:array(str(300),8),
});
export const localAnalysisSchema=object({
 format:{const:'control-room-project-analysis'},version:{const:1},
 repository:object({key:{...str(128),pattern:'^[a-zA-Z0-9_-]+$'},name:str(100),head:{...str(64,40),pattern:'^(?:[a-f0-9]{40}|[a-f0-9]{64})$'},dirty:{type:'boolean'},snapshotSha256:digest,files:integer(1,2000),bytes:integer(1,8*1024*1024),includedChanges:{const:true},excludedFiles:integer(0,1000000)}),
 run:object({id:{...str(36,36),pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'},provider:{const:'codex'},requestedModel:{const:'gpt-6.1-sol'},observedModel:{enum:['gpt-6.1-sol',null]},startedAt:str(40),completedAt:str(40),mode:{const:'read-only'},source:{const:'paired-local-companion'}}),
 ...reportContentSchema.properties,
});
// This one optional field preserves the exact serialized legacy report contract.
localAnalysisSchema.properties.chatContext=chatContextSchema;
function invalid(path){throw new Error(`Invalid local analysis${path?` at ${path}`:''}.`);}
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
 if(schema.type==='string'&&(typeof value!=='string'||value.length<schema.minLength||value.length>schema.maxLength||value.includes('\0')||schema.minLength>0&&!value.trim()||schema.pattern&&!new RegExp(schema.pattern,'u').test(value)))invalid(path);
 if(schema.type==='integer'&&(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum))invalid(path);
 if(schema.type==='boolean'&&typeof value!=='boolean')invalid(path);
}
function sourcePath(path){
 if(path.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'||/[. ]$/u.test(part))||/[<>|?*%]/u.test(path))invalid('source path');
}
export function validateChatContextMetadata(value){
 check(chatContextSchema,value);const c=value;if(c.sources.length!==2||new Set(c.sources.map(s=>s.provider)).size!==2||c.includedCharacters!==c.sources.reduce((sum,s)=>sum+s.characters,0))invalid('chat coverage');for(const s of c.sources){if(s.latestAt!==null&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(s.latestAt)||!Number.isFinite(Date.parse(s.latestAt))||new Date(s.latestAt).toISOString().slice(0,10)!==s.latestAt.slice(0,10)))invalid('chat time');if(s.status==='included'?(s.messages===0||s.characters===0||s.match===null||s.latestAt===null||s.excerptSha256===null):(s.messages!==0||s.characters!==0||s.excerptSha256!==null))invalid('chat source coverage');}return JSON.parse(JSON.stringify(value));
}
export function validateReportContent(value){
 check(reportContentSchema,value);
 for(const row of value.architecture)for(const path of row.paths)sourcePath(path);
 for(const row of value.findings)sourcePath(row.path);
 return JSON.parse(JSON.stringify(value));
}
export function validateLocalAnalysis(value){
 check(localAnalysisSchema,value);
 validateReportContent({summary:value.summary,architecture:value.architecture,findings:value.findings,suggestedTasks:value.suggestedTasks,limitations:value.limitations});
 for(const time of [value.run.startedAt,value.run.completedAt])if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(time)||!Number.isFinite(Date.parse(time))||new Date(time).toISOString().slice(0,10)!==time.slice(0,10))invalid('run time');
 if(Date.parse(value.run.completedAt)<Date.parse(value.run.startedAt))invalid('run time order');
 if(value.chatContext)validateChatContextMetadata(value.chatContext);
 const serialized=JSON.stringify(value);if(serialized.length>LOCAL_ANALYSIS_MAX_CHARACTERS||new TextEncoder().encode(serialized).length>55000)invalid('report size');
 return JSON.parse(serialized);
}
