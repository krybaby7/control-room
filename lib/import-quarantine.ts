import type { WorkspaceEnvelope } from './types.ts';
import { parsePlanningImport } from './workspace-codec.ts';
import { BUNDLE_LIMITS, canonical, contentHash, exportRegistry, parseWorkspaceBundle, type ExportRegistry, type WorkspaceBundle } from './workspace-export.ts';
export interface ImportDiagnostic {path:string;code:string;}
export interface ImportStage {id:string;ownerId:string;hash:string;createdAt:number;expiresAt:number;bytes:number;diagnostics:ImportDiagnostic[];bundle:WorkspaceBundle|null;}
export interface ImportDiff {before:number;after:number;added:string[];deleted:string[];changed:string[];}
export interface ImportPreview {importId:string;hash:string;targetRevision:number;backupAvailable:boolean;diagnostics:ImportDiagnostic[];diff:Record<string,ImportDiff>;moduleVersions:Record<string,number>;attachmentCompleteness:string;}
interface Stored {metadata:ImportStage;raw:Uint8Array;}
/** Bounded process-local staging core. A durable HTTP adapter must persist equivalent owner/hash/TTL guards. */
export class ImportQuarantine {
  private stages=new Map<string,Stored>();
  private options:{now?:()=>number;ttlMs?:number;maxStages?:number;registry?:ExportRegistry};
  constructor(options:{now?:()=>number;ttlMs?:number;maxStages?:number;registry?:ExportRegistry}={}) {
    this.options=options;
    if(options.ttlMs!==undefined && (!Number.isSafeInteger(options.ttlMs)||options.ttlMs<1||options.ttlMs>86_400_000)) throw new Error('Invalid staging TTL.');
    if(options.maxStages!==undefined && (!Number.isSafeInteger(options.maxStages)||options.maxStages<1||options.maxStages>20)) throw new Error('Invalid staging capacity.');
  }
  private now():number { return (this.options.now??Date.now)(); }
  private prune():void {for(const [id,entry]of this.stages) if(entry.metadata.expiresAt<=this.now()) this.stages.delete(id);}
  private owned(ownerId:string,id:string):Stored {this.prune(); const entry=this.stages.get(id);if(!ownerId||entry?.metadata.ownerId!==ownerId) throw new Error('Import not found or expired.');return entry;}
  async stage(ownerId:string,bytes:Uint8Array):Promise<ImportStage> {
    if(!ownerId) throw new Error('A signed-in owner is required.'); this.prune();
    if(bytes.byteLength>BUNDLE_LIMITS.bytes) throw new Error('Import byte limit exceeded.');
    if(this.stages.size>=(this.options.maxStages??8)) throw new Error('Quarantine capacity exceeded.');
    const raw=bytes.slice();const hash=await contentHash(raw); const now=this.now();
    const metadata:ImportStage={id:crypto.randomUUID(),ownerId,hash,createdAt:now,expiresAt:now+(this.options.ttlMs??3_600_000),bytes:raw.byteLength,diagnostics:[],bundle:null};
    let value:unknown;
    try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch {metadata.diagnostics.push({path:'$',code:'invalid-utf8-or-json'});}
    if(!metadata.diagnostics.length) try {
      if(value && typeof value==='object' && 'format' in value) metadata.bundle=parseWorkspaceBundle(value,this.options.registry??exportRegistry);
      else {const planning=parsePlanningImport(value); metadata.bundle={format:'control-room',bundleVersion:1,exportedAt:new Date(now).toISOString(),source:{workspaceRevision:1,planningSchemaVersion:planning.schemaVersion,moduleWatermarks:{},sourceHashes:{}},planning,modules:{},attachments:[],completeness:'metadata-only'};}
    }catch {metadata.diagnostics.push({path:'$',code:'invalid-schema-version-module-or-reference'});}
    this.stages.set(metadata.id,{metadata,raw}); return structuredClone(metadata);
  }
  get(ownerId:string,id:string):ImportStage {return structuredClone(this.owned(ownerId,id).metadata);}
  download(ownerId:string,id:string):Uint8Array {return this.owned(ownerId,id).raw.slice();}
  cancel(ownerId:string,id:string):void {this.owned(ownerId,id);this.stages.delete(id);}
  preview(ownerId:string,id:string,current:WorkspaceEnvelope,currentModules:WorkspaceBundle['modules']={}):ImportPreview {
    const stage=this.owned(ownerId,id).metadata;const bundle=stage.bundle; const diff:Record<string,ImportDiff>={};
    if(bundle) {
      for(const key of ['projects','milestones','tasks','captures','activity'] as const) diff[`planning.${key}`]=compare(current.workspace[key],bundle.planning[key]);
      for(const [key,module]of Object.entries(bundle.modules)) diff[key]=compare(currentModules[key]?.records??[],module.records);
    }
    return {importId:id,hash:stage.hash,targetRevision:current.revision,backupAvailable:!!current.previousBackupAvailable,diagnostics:structuredClone(stage.diagnostics),diff,moduleVersions:Object.fromEntries(Object.entries(bundle?.modules??{}).map(([key,module])=>[key,module.schemaVersion])),attachmentCompleteness:bundle?.completeness??'invalid'};
  }
  /** Returns a copy only. This core does not implement an authoritative restore or mutation. */
  parsedForReview(ownerId:string,id:string,hash:string,targetRevision:number,currentRevision:number):WorkspaceBundle {
    const stage=this.owned(ownerId,id).metadata;
    if(hash!==stage.hash||targetRevision!==currentRevision||!stage.bundle||stage.diagnostics.length) throw new Error('Invalid or stale import preview.');
    return structuredClone(stage.bundle);
  }
}
function compare(before:unknown[],after:unknown[]):ImportDiff {
  const index=(rows:unknown[])=>{const result=new Map<string,unknown>();for(const row of rows) {const id=(row as {id?:unknown})?.id;if(typeof id!=='string'||result.has(id)) throw new Error('Invalid or duplicate record identity.');result.set(id,row);}return result;};
  const left=index(before),right=index(after);
  return {before:left.size,after:right.size,added:[...right.keys()].filter(id=>!left.has(id)),deleted:[...left.keys()].filter(id=>!right.has(id)),changed:[...right.keys()].filter(id=>left.has(id)&&canonical(left.get(id))!==canonical(right.get(id)))};
}
