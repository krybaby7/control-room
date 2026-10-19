import {agentReferenceDescriptors} from './agents/module.ts';
import {runtimeReferenceDescriptors} from './runtime/module.ts';
import {baselineReferenceDescriptors} from './baselines/module.ts';
import {reviewReferenceDescriptors} from './reviews/module.ts';
import {sourceReferenceDescriptors} from './sources/module.ts';
import {evidenceReferenceDescriptors} from './evidence-module.ts';
import {planningReferenceDescriptors} from './planning-module.ts';
import {z} from 'zod';
import type {Workspace} from './types.ts';
import {OWNER_TABLES,ownerTable,type RegisteredOwnerTable,type OwnerScopedReader} from './workspace-modules.ts';
import {assertPortable,canonical,contentHash} from './workspace-export.ts';

export const REFERENCE_KINDS=['project','milestone','task','capture','evidence','decision','attachment','source-connection','source','source-observation','review-snapshot','automation-schedule','baseline-revision','device','runtime-evidence','agent-job','agent-result','evaluation-run'] as const;
export type ReferenceKind=typeof REFERENCE_KINDS[number];
const id=z.string().min(1).max(128).refine(value=>value.trim()===value);
const referenceSchema=z.object({kind:z.enum(REFERENCE_KINDS),id,path:z.array(z.union([z.string().min(1),z.number().int().nonnegative().safe()])).min(1).max(40)}).strict();
export type TypedReference=z.infer<typeof referenceSchema>;
// Same normalized row envelope used by owner export adapters; reject additional metadata.
const rowSchema=z.object({id,row_revision:z.number().int().positive().safe(),payload_json:z.string(),content_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export interface ReferenceMapping {reference:TypedReference;target:{kind:ReferenceKind;id:string}}
export interface ReferenceDescriptor {
  key:RegisteredOwnerTable;schemaVersion:number;
  /** Entity kind supplied by each row ID, if this module defines target entities. */
  entityKind?:ReferenceKind;
  parse(value:unknown):unknown;
  references(value:unknown):TypedReference[];
  /** Explicit caller-reviewed mappings only; never inferred from matching strings. */
  repair?(value:unknown,mappings:readonly ReferenceMapping[]):unknown;
}
export class ReferenceRegistry {
  private descriptors=new Map<RegisteredOwnerTable,ReferenceDescriptor>();
  register(descriptor:ReferenceDescriptor):void {
    const key=ownerTable(descriptor.key);
    if(this.descriptors.has(key)||!Number.isSafeInteger(descriptor.schemaVersion)||descriptor.schemaVersion<1||typeof descriptor.parse!=='function'||typeof descriptor.references!=='function'||descriptor.entityKind!==undefined&&!REFERENCE_KINDS.includes(descriptor.entityKind))throw new Error('Invalid or duplicate reference descriptor.');
    this.descriptors.set(key,Object.freeze({...descriptor}));
  }
  get(key:string):ReferenceDescriptor {const descriptor=this.descriptors.get(ownerTable(key));if(!descriptor)throw new Error('Missing typed reference descriptor.');return descriptor;}
  entries():ReferenceDescriptor[]{return [...this.descriptors.values()].sort((a,b)=>a.key.localeCompare(b.key));}
}
/** Feature modules register their actual codecs during server initialization. */
export const referenceRegistry=new ReferenceRegistry();
export interface ReferenceRow {module:RegisteredOwnerTable;id:string;rowRevision:number;contentHash:string;references:TypedReference[]}
export interface ReferenceSnapshot {rows:ReferenceRow[];digest:string;coveredModules:RegisteredOwnerTable[]}
export const REFERENCE_LIMITS=Object.freeze({pageSize:200,rows:10000,bytes:8_000_000,references:50000});
/** The supplied reader must already be bound to the authenticated owner. No owner override exists here.
 * Recheck the complete row set atomically at commit, including absence of newly inserted rows;
 * comparing only row preconditions or an earlier digest cannot close that race.
 */
export async function readReferenceSnapshot(query:OwnerScopedReader,registry:ReferenceRegistry):Promise<ReferenceSnapshot>{
  const rows:ReferenceRow[]=[];let bytes=0,references=0;
  for(const table of OWNER_TABLES){let after='';
    for(;;){const page=await query.list(table,{after,limit:REFERENCE_LIMITS.pageSize});if(page.length>REFERENCE_LIMITS.pageSize)throw new Error('Reference page exceeds limit.');
      for(const raw of page){const row=rowSchema.parse(raw);if(row.id<=after)throw new Error('Invalid reference pagination.');after=row.id;
        bytes+=new TextEncoder().encode(row.payload_json).byteLength;if(bytes>REFERENCE_LIMITS.bytes||rows.length>=REFERENCE_LIMITS.rows)throw new Error('Reference snapshot exceeds limit.');
        const descriptor=registry.get(table);let value:unknown;try{value=descriptor.parse(JSON.parse(row.payload_json));}catch{throw new Error('Invalid normalized reference payload.');}assertPortable(value);
        // Hash the stored payload, not a parser's possibly transformed representation.
        if(await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('Reference row digest mismatch.');
        const refs=z.array(referenceSchema).parse(descriptor.references(value));references+=refs.length;if(references>REFERENCE_LIMITS.references)throw new Error('Reference snapshot exceeds limit.');
        refs.sort((a,b)=>canonical(a).localeCompare(canonical(b)));if(new Set(refs.map(canonical)).size!==refs.length)throw new Error('Duplicate typed reference.');
        rows.push({module:table,id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,references:refs});
      }if(page.length<REFERENCE_LIMITS.pageSize)break;
    }
  }
  const coveredModules=[...OWNER_TABLES];return {rows,coveredModules,digest:await contentHash(canonical({coveredModules,rows}))};
}
export interface ReferenceImpact {references:Array<TypedReference & {module:RegisteredOwnerTable;sourceId:string}>;dangling:Array<TypedReference & {module:RegisteredOwnerTable;sourceId:string}>;canDelete:boolean}
/** Only declared entity kinds form closed target sets. Undeclared future kinds remain unresolved. */
export function referenceImpact(planning:Workspace,snapshot:ReferenceSnapshot,registry:ReferenceRegistry,target:{kind:ReferenceKind;id:string}):ReferenceImpact {
  z.object({kind:z.enum(REFERENCE_KINDS),id}).strict().parse(target);
  const targets=new Map<ReferenceKind,Set<string>>([
    ['project',new Set(planning.projects.map(row=>row.id))],['milestone',new Set(planning.milestones.map(row=>row.id))],['task',new Set(planning.tasks.map(row=>row.id))],['capture',new Set(planning.captures.map(row=>row.id))],
  ]);
  for(const descriptor of registry.entries())if(descriptor.entityKind&&!targets.has(descriptor.entityKind))targets.set(descriptor.entityKind,new Set());
  for(const row of snapshot.rows){const descriptor=registry.get(row.module);if(descriptor.entityKind)targets.get(descriptor.entityKind)!.add(row.id);}
  const result:ReferenceImpact={references:[],dangling:[],canDelete:true};
  for(const row of snapshot.rows)for(const ref of row.references){const source={...ref,module:row.module,sourceId:row.id};if(ref.kind===target.kind&&ref.id===target.id)result.references.push(source);if(targets.has(ref.kind)&&!targets.get(ref.kind)!.has(ref.id))result.dangling.push(source);}
  result.canDelete=result.references.length===0;return result;
}

for(const descriptor of [...planningReferenceDescriptors,...evidenceReferenceDescriptors,...sourceReferenceDescriptors,...reviewReferenceDescriptors,...baselineReferenceDescriptors,...runtimeReferenceDescriptors,...agentReferenceDescriptors])referenceRegistry.register(descriptor);
