import {canonical,contentHash} from './canonical-json.ts';
import {assertPortable} from './workspace-export-core.ts';

export const RECOVERY_SEGMENT_LIMITS=Object.freeze({segmentBytes:1_800_000,manifestBytes:1_800_000,segments:512,rows:100_000,rowsPerSegment:200,modules:128,totalBytes:64*1024*1024});
export interface RecoveryContext {snapshotId:string;ownerContextHash:string;workspaceRevision:number;operationalWatermarks:Record<string,number>}
export interface RecoveryRow {id:string;rowRevision:number;contentHash:string;value:unknown}
export interface RecoveryModuleSpec {key:string;schemaVersion:number}
export interface RecoveryModuleInput extends RecoveryModuleSpec {rows:Iterable<RecoveryRow>|AsyncIterable<RecoveryRow>}
export interface RecoverySegmentDescriptor {index:number;bytes:number;sha256:string;rows:number;firstId:string;lastId:string}
export interface RecoveryModuleDescriptor extends RecoveryModuleSpec {rows:number;bytes:number;sha256:string;segments:RecoverySegmentDescriptor[]}
export interface RecoveryManifest {format:'control-room-segmented-recovery';version:2;context:RecoveryContext;contextHash:string;completeness:'metadata-only';authority:'untrusted-data';modules:RecoveryModuleDescriptor[];totalRows:number;totalBytes:number;sha256:string}
export interface EncodedRecoverySegment {module:string;index:number;content:string;descriptor:RecoverySegmentDescriptor}
export interface RecoveryCursor {version:2;manifestHash:string;contextHash:string;moduleOrdinal:number;segmentIndex:number;segmentHash:string;rowOffset:number}
export type RecoveryDecodeItem={kind:'row';module:string;row:RecoveryRow;cursor:RecoveryCursor}|{kind:'complete';manifestHash:string;cursor:RecoveryCursor};
export class RecoverySegmentError extends Error {readonly code:string;constructor(code:string){super('Segmented recovery: '+code);this.name='RecoverySegmentError';this.code=code;}}
const fail=(code:string):never=>{throw new RecoverySegmentError(code);};
const encoder=new TextEncoder();
const bytes=(value:string)=>encoder.encode(value).byteLength;
/** Match SQLite BINARY text order, including supplementary Unicode IDs. */
function compareIds(left:string,right:string):number{const a=encoder.encode(left),b=encoder.encode(right);for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length;}
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value:unknown,min=0)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
function exact(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))return fail('shape');
 for(const key of keys)if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'))return fail('shape');
 return value as Record<string,unknown>;
}
function id(value:unknown,max=1024):value is string{return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);}
function contextValue(raw:unknown):RecoveryContext{
 const c=exact(raw,['snapshotId','ownerContextHash','workspaceRevision','operationalWatermarks']);
 if(!id(c.snapshotId,128)||!hash(c.ownerContextHash)||!integer(c.workspaceRevision))return fail('context');
 const vector=c.operationalWatermarks;if(!vector||Object.getPrototypeOf(vector)!==Object.prototype||Object.keys(vector).length>32)return fail('context');
 for(const [key,value]of Object.entries(vector))if(!/^[a-z][a-z0-9_-]{0,63}$/.test(key)||!integer(value)||!Object.hasOwn(Object.getOwnPropertyDescriptor(vector,key)!,'value'))return fail('context');
 return JSON.parse(canonical(c)) as RecoveryContext;
}
function specs(raw:readonly RecoveryModuleSpec[]):RecoveryModuleSpec[]{
 if(!Array.isArray(raw)||raw.length<1||raw.length>RECOVERY_SEGMENT_LIMITS.modules)return fail('modules');
 let previous='';return raw.map(value=>{const spec=exact(value,['key','schemaVersion']);if(typeof spec.key!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(spec.key)||spec.key<=previous||!integer(spec.schemaVersion,1))return fail('module-order');previous=spec.key;return {key:spec.key,schemaVersion:spec.schemaVersion as number};});
}
async function rowValue(raw:unknown):Promise<RecoveryRow>{
 const row=exact(raw,['id','rowRevision','contentHash','value']),identity=row.id,revision=row.rowRevision,digest=row.contentHash;if(!id(identity)||!integer(revision,1)||!hash(digest))return fail('row');
 try{assertPortable(row.value);}catch{return fail('row-portability');}
 const value=JSON.parse(canonical(row.value));if(await contentHash(canonical(value))!==digest)return fail('row-hash');
 return {id:identity,rowRevision:revision as number,contentHash:digest as string,value};
}
async function moduleDigest(segments:RecoverySegmentDescriptor[]):Promise<string>{return contentHash(canonical(segments));}
function segmentString(contextHash:string,recoveryModule:RecoveryModuleSpec,index:number,rows:RecoveryRow[]):string{return canonical({format:'control-room-recovery-segment',version:2,contextHash,module:recoveryModule.key,schemaVersion:recoveryModule.schemaVersion,index,rows});}

/** Stream bounded immutable segments to caller-owned staging. This is not a usable
 * backup, domain/reference validation, storage authorization, or destination activation. */
export async function encodeRecoverySegments(input:{context:RecoveryContext;modules:readonly RecoveryModuleInput[];segmentBytes?:number;onSegment:(segment:EncodedRecoverySegment)=>Promise<void>}):Promise<RecoveryManifest>{
 const context=contextValue(input.context),contextHash=await contentHash(canonical(context)),limit=input.segmentBytes??262144;
 if(!integer(limit,1024)||limit>RECOVERY_SEGMENT_LIMITS.segmentBytes||typeof input.onSegment!=='function')return fail('limit');
 const expected=specs(input.modules.map(({key,schemaVersion})=>({key,schemaVersion}))),modules:RecoveryModuleDescriptor[]=[];let totalRows=0,totalBytes=0,totalSegments=0;
 for(let ordinal=0;ordinal<expected.length;ordinal++){
  const spec=expected[ordinal],descriptors:RecoverySegmentDescriptor[]=[];let pending:RecoveryRow[]=[],previous='',moduleRows=0,moduleBytes=0;
  async function flush(){
   if(!pending.length)return;
   const content=segmentString(contextHash,spec,descriptors.length,pending),size=bytes(content);
   if(size>limit||++totalSegments>RECOVERY_SEGMENT_LIMITS.segments||totalBytes+size>RECOVERY_SEGMENT_LIMITS.totalBytes)return fail('limit');
   const descriptor={index:descriptors.length,bytes:size,sha256:await contentHash(content),rows:pending.length,firstId:pending[0].id,lastId:pending[pending.length-1].id};
   descriptors.push(descriptor);totalBytes+=size;moduleBytes+=size;pending=[];
   await input.onSegment({module:spec.key,index:descriptor.index,content,descriptor:{...descriptor}});
  }
  for await(const raw of input.modules[ordinal].rows){
   const row=await rowValue(raw);if(compareIds(row.id,previous)<=0)return fail('row-order');previous=row.id;
   if(++totalRows>RECOVERY_SEGMENT_LIMITS.rows)return fail('limit');moduleRows++;
   if(pending.length&&(pending.length===RECOVERY_SEGMENT_LIMITS.rowsPerSegment||bytes(segmentString(contextHash,spec,descriptors.length,[...pending,row]))>limit))await flush();
   pending.push(row);if(bytes(segmentString(contextHash,spec,descriptors.length,pending))>limit)return fail('row-too-large');
  }
  await flush();modules.push({...spec,rows:moduleRows,bytes:moduleBytes,sha256:await moduleDigest(descriptors),segments:descriptors});
 }
 const value={format:'control-room-segmented-recovery' as const,version:2 as const,context,contextHash,completeness:'metadata-only' as const,authority:'untrusted-data' as const,modules,totalRows,totalBytes};
 const manifest={...value,sha256:await contentHash(canonical(value))};if(bytes(canonical(manifest))>RECOVERY_SEGMENT_LIMITS.manifestBytes||totalBytes+bytes(canonical(manifest))>RECOVERY_SEGMENT_LIMITS.totalBytes)return fail('limit');return manifest;
}
function text(raw:string|Uint8Array,limit:number):string{
 if(typeof raw==='string'){if(bytes(raw)>limit)return fail('limit');return raw;}
 if(!(raw instanceof Uint8Array)||raw.byteLength>limit)return fail('limit');
 try{return new TextDecoder('utf-8',{fatal:true}).decode(raw.slice());}catch{return fail('encoding');}
}
/** expectedContext and expectedModules must come from trusted server snapshot/
 * registry state, not from the imported manifest itself. No private authority is restored. */
export async function validateRecoveryManifest(raw:unknown,expectedContext:RecoveryContext,expectedModules:readonly RecoveryModuleSpec[]):Promise<RecoveryManifest>{
 let providedText:string|null=null;
 if(typeof raw==='string'||raw instanceof Uint8Array){try{providedText=text(raw,RECOVERY_SEGMENT_LIMITS.manifestBytes);raw=JSON.parse(providedText);}catch(error){if(error instanceof RecoverySegmentError)throw error;return fail('manifest');}}
 let frozen:unknown;try{frozen=JSON.parse(canonical(raw));}catch{return fail('manifest');}
 if(bytes(canonical(frozen))>RECOVERY_SEGMENT_LIMITS.manifestBytes)return fail('limit');
 if(providedText!==null&&providedText!==canonical(frozen))return fail('manifest-encoding');
 const m=exact(frozen,['format','version','context','contextHash','completeness','authority','modules','totalRows','totalBytes','sha256']);
 if(m.format!=='control-room-segmented-recovery'||m.version!==2||m.completeness!=='metadata-only'||m.authority!=='untrusted-data'||!hash(m.sha256)||!hash(m.contextHash))return fail('manifest');
 const expected=contextValue(expectedContext),context=contextValue(m.context);if(canonical(context)!==canonical(expected)||await contentHash(canonical(context))!==m.contextHash)return fail('context');
 const expectedSpecs=specs(expectedModules);if(!Array.isArray(m.modules)||m.modules.length!==expectedSpecs.length)return fail('modules');
 let count=0,total=0,segments=0;
 for(let ordinal=0;ordinal<m.modules.length;ordinal++){
  const recoveryModule=exact(m.modules[ordinal],['key','schemaVersion','rows','bytes','sha256','segments']),spec=expectedSpecs[ordinal];
  if(recoveryModule.key!==spec.key||recoveryModule.schemaVersion!==spec.schemaVersion||!hash(recoveryModule.sha256)||!integer(recoveryModule.rows)||!integer(recoveryModule.bytes)||!Array.isArray(recoveryModule.segments))return fail('modules');
  let rows=0,size=0,previous='';
  for(const [index,item]of recoveryModule.segments.entries()){
   const segment=exact(item,['index','bytes','sha256','rows','firstId','lastId']);
   if(segment.index!==index||!integer(segment.bytes,1)||(segment.bytes as number)>RECOVERY_SEGMENT_LIMITS.segmentBytes||!hash(segment.sha256)||!integer(segment.rows,1)||(segment.rows as number)>RECOVERY_SEGMENT_LIMITS.rowsPerSegment||!id(segment.firstId)||!id(segment.lastId)||compareIds(segment.firstId,previous)<=0||compareIds(segment.lastId,segment.firstId)<0)return fail('segment-order');
   previous=segment.lastId;rows+=segment.rows as number;size+=segment.bytes as number;
   if(++segments>RECOVERY_SEGMENT_LIMITS.segments)return fail('limit');
  }
  if(rows!==recoveryModule.rows||size!==recoveryModule.bytes||await moduleDigest(recoveryModule.segments as RecoverySegmentDescriptor[])!==recoveryModule.sha256)return fail('module-hash');
  count+=rows;total+=size;
 }
 if(!integer(m.totalRows)||!integer(m.totalBytes)||count!==m.totalRows||total!==m.totalBytes)return fail('counts');
 if(count>RECOVERY_SEGMENT_LIMITS.rows||total+bytes(canonical(frozen))>RECOVERY_SEGMENT_LIMITS.totalBytes)return fail('limit');
 const {sha256,...body}=m;if(await contentHash(canonical(body))!==sha256)return fail('manifest-hash');
 return frozen as RecoveryManifest;
}
async function readVerified(manifest:RecoveryManifest,ordinal:number,index:number,read:(recoveryModule:string,index:number)=>Promise<string|Uint8Array>):Promise<RecoveryRow[]>{
 const recoveryModule=manifest.modules[ordinal],descriptor=recoveryModule.segments[index];
 let content:string;try{content=text(await read(recoveryModule.key,index),RECOVERY_SEGMENT_LIMITS.segmentBytes);}catch(error){if(error instanceof RecoverySegmentError)throw error;return fail('segment-missing');}
 if(bytes(content)!==descriptor.bytes||await contentHash(content)!==descriptor.sha256)return fail('segment-hash');
 let parsed:Record<string,unknown>;try{parsed=exact(JSON.parse(content),['format','version','contextHash','module','schemaVersion','index','rows']);}catch{return fail('segment-shape');}
 if(parsed.format!=='control-room-recovery-segment'||parsed.version!==2||parsed.contextHash!==manifest.contextHash||parsed.module!==recoveryModule.key||parsed.schemaVersion!==recoveryModule.schemaVersion||parsed.index!==index||!Array.isArray(parsed.rows)||parsed.rows.length!==descriptor.rows||canonical(parsed)!==content)return fail('segment-shape');
 const rows:RecoveryRow[]=[];let previous='';
 for(const raw of parsed.rows){const row=await rowValue(raw);if(compareIds(row.id,previous)<=0)return fail('row-order');previous=row.id;rows.push(row);}
 if(rows[0].id!==descriptor.firstId||rows[rows.length-1].id!==descriptor.lastId)return fail('segment-order');
 return rows;
}
function cursor(manifest:RecoveryManifest,moduleOrdinal:number,segmentIndex:number,segmentHash:string,rowOffset:number):RecoveryCursor{return {version:2,manifestHash:manifest.sha256,contextHash:manifest.contextHash,moduleOrdinal,segmentIndex,segmentHash,rowOffset};}
function checkedCursor(raw:unknown,manifest:RecoveryManifest):RecoveryCursor{
 const c=exact(raw,['version','manifestHash','contextHash','moduleOrdinal','segmentIndex','segmentHash','rowOffset']);
 if(c.version!==2||c.manifestHash!==manifest.sha256||c.contextHash!==manifest.contextHash||!integer(c.moduleOrdinal)||!integer(c.segmentIndex)||!integer(c.rowOffset)||!hash(c.segmentHash))return fail('cursor');
 if(c.moduleOrdinal===manifest.modules.length){if(c.segmentIndex!==0||c.rowOffset!==0||c.segmentHash!==manifest.sha256)return fail('cursor');}
 else{const descriptor=manifest.modules[c.moduleOrdinal as number]?.segments[c.segmentIndex as number];if(!descriptor||c.segmentHash!==descriptor.sha256||(c.rowOffset as number)>descriptor.rows)return fail('cursor');}
 return JSON.parse(canonical(c)) as RecoveryCursor;
}
/** Always verifies every segment before yielding the first row, and verifies again
 * as it reads. Destination rows remain quarantined until the complete marker and
 * independent domain/reference checks. A digest cursor is not destination proof:
 * resume requires equality with a server-owned durable trustedCheckpoint. */
export async function* decodeRecoverySegments(raw:unknown,options:{expectedContext:RecoveryContext;expectedModules:readonly RecoveryModuleSpec[];readSegment:(recoveryModule:string,index:number)=>Promise<string|Uint8Array>;resume?:{cursor:RecoveryCursor;trustedCheckpoint:RecoveryCursor}}):AsyncGenerator<RecoveryDecodeItem>{
 const manifest=await validateRecoveryManifest(raw,options.expectedContext,options.expectedModules);
 let resume:RecoveryCursor|null=null;
 if(options.resume){resume=checkedCursor(options.resume.cursor,manifest);const trusted=checkedCursor(options.resume.trustedCheckpoint,manifest);if(canonical(resume)!==canonical(trusted))return fail('cursor-checkpoint');}
 for(let m=0;m<manifest.modules.length;m++)for(let s=0;s<manifest.modules[m].segments.length;s++)await readVerified(manifest,m,s,options.readSegment);
 for(let m=0;m<manifest.modules.length;m++)for(let s=0;s<manifest.modules[m].segments.length;s++){
  const rows=await readVerified(manifest,m,s,options.readSegment),descriptor=manifest.modules[m].segments[s];
  for(let r=0;r<rows.length;r++){
   if(resume&&(m<resume.moduleOrdinal||m===resume.moduleOrdinal&&(s<resume.segmentIndex||s===resume.segmentIndex&&r<resume.rowOffset)))continue;
   yield {kind:'row',module:manifest.modules[m].key,row:rows[r],cursor:cursor(manifest,m,s,descriptor.sha256,r+1)};
  }
 }
 yield {kind:'complete',manifestHash:manifest.sha256,cursor:cursor(manifest,manifest.modules.length,0,manifest.sha256,0)};
}
