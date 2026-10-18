import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {encodeRecoverySegments,decodeRecoverySegments,validateRecoveryManifest,RECOVERY_SEGMENT_LIMITS,type RecoveryContext,type RecoveryRow,type RecoveryManifest,type RecoveryCursor} from '../lib/recovery-segments.ts';
const context:RecoveryContext={snapshotId:'synthetic-frozen-snapshot',ownerContextHash:'a'.repeat(64),workspaceRevision:42,operationalWatermarks:{automations:3,sources:9}};
const expectedModules=[{key:'evidence_records',schemaVersion:1},{key:'planning',schemaVersion:4}];
async function row(id:string,value:unknown):Promise<RecoveryRow>{return {id,rowRevision:1,contentHash:await contentHash(canonical(value)),value};}
async function fixture(){
 const segments=new Map<string,string>();
 const manifest=await encodeRecoverySegments({context,segmentBytes:1024,modules:[{...expectedModules[0],rows:[await row('original-a',{text:'مرحباこんにちは"\\'.repeat(12)}),await row('original-b',{text:'مرحباこんにちは"\\'.repeat(12)}),await row('original-c',{text:'مرحباこんにちは"\\'.repeat(12)})]},{...expectedModules[1],rows:[await row('workspace',{schemaVersion:4,title:'Synthetic only'})]}],onSegment:async segment=>{segments.set(segment.module+':'+segment.index,segment.content);}});
 return {manifest,segments,readSegment:async(module:string,index:number)=>{const value=segments.get(module+':'+index);if(value===undefined)throw new Error('missing synthetic segment');return value;}};
}
async function collect(manifest:RecoveryManifest,readSegment:(module:string,index:number)=>Promise<string|Uint8Array>,extra:Partial<Parameters<typeof decodeRecoverySegments>[1]>={}){
 const values=[];for await(const value of decodeRecoverySegments(manifest,{expectedContext:context,expectedModules,readSegment,...extra}))values.push(value);return values;
}
async function rehashManifest(manifest:RecoveryManifest){for(const module of manifest.modules)module.sha256=await contentHash(canonical(module.segments));const {sha256,...body}=manifest;void sha256;manifest.sha256=await contentHash(canonical(body));return manifest;}
test('version2 segments preserve literal IDs and exact Unicode/escaping bytes without claiming a usable backup',async()=>{
 const f=await fixture();assert.equal(f.manifest.version,2);assert.equal(f.manifest.completeness,'metadata-only');assert.equal(f.manifest.authority,'untrusted-data');
 assert.ok(f.manifest.modules[0].segments.length>1);
 let total=0;
 for(const module of f.manifest.modules)for(const descriptor of module.segments){const content=await f.readSegment(module.key,descriptor.index);assert.equal(Buffer.byteLength(content),descriptor.bytes);assert.ok(descriptor.bytes<=1024);assert.equal(await contentHash(content),descriptor.sha256);total+=descriptor.bytes;}
 assert.equal(f.manifest.totalBytes,total);
 const decoded=await collect(f.manifest,f.readSegment),rows=decoded.filter(value=>value.kind==='row');assert.deepEqual(rows.map(value=>value.row.id),['original-a','original-b','original-c','workspace']);assert.equal(rows[0].row.value&&typeof rows[0].row.value,'object');assert.equal(decoded.at(-1)?.kind,'complete');
 assert.deepEqual(await validateRecoveryManifest(canonical(f.manifest),context,expectedModules),f.manifest);
});
test('segmented profile handles more than8MB and10000 rows without changing v1 limits or collecting full output',async()=>{
 const {BUNDLE_LIMITS}=await import('../lib/workspace-export-core.ts'),segments=new Map<string,string>();
 async function* rows(){for(let i=0;i<10001;i++)yield row('synthetic-'+String(i).padStart(5,'0'),{text:'x'.repeat(850),ordinal:i});}
 const manifest=await encodeRecoverySegments({context,modules:[{key:'audit_events',schemaVersion:1,rows:rows()}],onSegment:async value=>{segments.set(value.module+':'+value.index,value.content);}});
 assert.equal(manifest.totalRows,10001);assert.ok(manifest.totalBytes>8_000_000);assert.equal(BUNDLE_LIMITS.bytes,8_000_000);assert.equal(BUNDLE_LIMITS.rows,10_000);
 let count=0,complete=false;
 for await(const value of decodeRecoverySegments(manifest,{expectedContext:context,expectedModules:[{key:'audit_events',schemaVersion:1}],readSegment:async(module,index)=>segments.get(module+':'+index)!})){if(value.kind==='row'){assert.equal(value.row.id,'synthetic-'+String(count).padStart(5,'0'));count++;}else complete=true;}
 assert.equal(count,10001);assert.equal(complete,true);
});
test('foreign owner, changed revision/vector, unknown versions and omitted modules cannot validate',async()=>{
 const f=await fixture();
 for(const expected of [{...context,ownerContextHash:'b'.repeat(64)},{...context,workspaceRevision:43},{...context,operationalWatermarks:{...context.operationalWatermarks,sources:10}}])await assert.rejects(validateRecoveryManifest(f.manifest,expected,expectedModules),/context/);
 const version=structuredClone(f.manifest);(version as {version:number}).version=3;await assert.rejects(validateRecoveryManifest(version,context,expectedModules),/manifest/);
 await assert.rejects(validateRecoveryManifest(f.manifest,context,[expectedModules[0]]),/modules/);
 const omitted=structuredClone(f.manifest);omitted.modules.pop();await rehashManifest(omitted);await assert.rejects(validateRecoveryManifest(omitted,context,expectedModules),/modules/);
});
test('missing, duplicated, reordered and corrupted segments fail before any rows are exposed',async()=>{
 for(const mode of ['missing','duplicate','reordered','tamper']){
  const f=await fixture(),entries=f.manifest.modules[0].segments;
  assert.ok(entries.length>1);
  const read=async(module:string,index:number)=>{if(module!=='evidence_records')return f.readSegment(module,index);if(mode==='missing'&&index===entries.length-1)throw new Error('missing');if(mode==='duplicate'&&index===1)return f.readSegment(module,0);if(mode==='reordered')return f.readSegment(module,entries.length-1-index);const original=await f.readSegment(module,index);return mode==='tamper'&&index===entries.length-1?original+' ':original;};
  const decoder=decodeRecoverySegments(f.manifest,{expectedContext:context,expectedModules,readSegment:read});
  await assert.rejects(decoder.next(),/segment-/);
 }
});
test('self-consistent outer hashes do not bypass immutable row content hashes or exact row order',async()=>{
 const f=await fixture(),manifest=structuredClone(f.manifest),descriptor=manifest.modules[0].segments[0],original=JSON.parse(await f.readSegment('evidence_records',0));original.rows[0].value.text='Changed without row digest';
 const replacement=canonical(original);descriptor.sha256=await contentHash(replacement);const delta=Buffer.byteLength(replacement)-descriptor.bytes;descriptor.bytes+=delta;manifest.modules[0].bytes+=delta;manifest.totalBytes+=delta;await rehashManifest(manifest);
 await assert.rejects(collect(manifest,async(module,index)=>module==='evidence_records'&&index===0?replacement:f.readSegment(module,index)),/row-hash/);
 const duplicate=await row('same',{text:'literal'});
 await assert.rejects(encodeRecoverySegments({context,modules:[{key:'planning',schemaVersion:4,rows:[duplicate,duplicate]}],onSegment:async()=>{}}),/row-order/);
});
test('resume positions require the exact trusted checkpoint and still verify every source segment',async()=>{
 const f=await fixture(),generator=decodeRecoverySegments(f.manifest,{expectedContext:context,expectedModules,readSegment:f.readSegment}),first=await generator.next();assert.equal(first.value.kind,'row');if(first.value.kind!=='row')throw new Error('missing fixture row');const checkpoint=first.value.cursor;await generator.return(undefined);
 const remaining=await collect(f.manifest,f.readSegment,{resume:{cursor:checkpoint,trustedCheckpoint:checkpoint}});assert.deepEqual(remaining.filter(value=>value.kind==='row').map(value=>value.row.id),['original-b','original-c','workspace']);
 const forged={...checkpoint,rowOffset:0};await assert.rejects(collect(f.manifest,f.readSegment,{resume:{cursor:forged,trustedCheckpoint:checkpoint}}),/cursor-checkpoint/);
 for(const cursor of [{...checkpoint,manifestHash:'b'.repeat(64)},{...checkpoint,contextHash:'b'.repeat(64)},{...checkpoint,segmentHash:'b'.repeat(64)},{...checkpoint,rowOffset:201},{...checkpoint,moduleOrdinal:999}])await assert.rejects(collect(f.manifest,f.readSegment,{resume:{cursor,trustedCheckpoint:cursor}}),/cursor/);
 const reads:string[]=[];await collect(f.manifest,async(module,index)=>{reads.push(module+':'+index);return f.readSegment(module,index);},{resume:{cursor:checkpoint,trustedCheckpoint:checkpoint}});assert.equal(reads.filter(value=>value==='evidence_records:0').length,2);
});
test('a changed second-pass object never produces a complete marker or bypasses source verification',async()=>{
 const f=await fixture(),seen=new Map<string,number>();let complete=false;
 const reader=async(module:string,index:number)=>{const key=module+':'+index,count=(seen.get(key)??0)+1;seen.set(key,count);const original=await f.readSegment(module,index);return module==='planning'&&count===2?original+' ':original;};
 await assert.rejects(async()=>{for await(const value of decodeRecoverySegments(f.manifest,{expectedContext:context,expectedModules,readSegment:reader}))if(value.kind==='complete')complete=true;},/segment-hash/);assert.equal(complete,false);
});
test('byte, descriptor, portability and aggregate limits fail explicitly; empty modules remain represented',async()=>{
 const tooLarge=await row('oversized',{text:'😀'.repeat(500)});
 await assert.rejects(encodeRecoverySegments({context,segmentBytes:1024,modules:[{key:'planning',schemaVersion:4,rows:[tooLarge]}],onSegment:async()=>{}}),/row-too-large/);
 await assert.rejects(encodeRecoverySegments({context,segmentBytes:RECOVERY_SEGMENT_LIMITS.segmentBytes+1,modules:[{key:'planning',schemaVersion:4,rows:[]}],onSegment:async()=>{}}),/limit/);
 await assert.rejects(encodeRecoverySegments({context,modules:[{key:'planning',schemaVersion:4,rows:[await row('private',{credential:'not-portable'})]}],onSegment:async()=>{}}),/row-portability/);
 const f=await fixture(),bad=structuredClone(f.manifest);bad.totalRows++;await rehashManifest(bad);await assert.rejects(validateRecoveryManifest(bad,context,expectedModules),/counts/);
 const many=structuredClone(f.manifest),module=many.modules[0];module.segments=Array.from({length:513},(_,index)=>({...module.segments[0],index,firstId:String(index).padStart(5,'0'),lastId:String(index).padStart(5,'0')}));await assert.rejects(validateRecoveryManifest(many,context,expectedModules),/limit/);
 const empty=await encodeRecoverySegments({context,modules:[{key:'planning',schemaVersion:4,rows:[]}],onSegment:async()=>{throw new Error('must not emit');}});assert.equal(empty.modules.length,1);assert.equal(empty.totalRows,0);assert.equal(empty.modules[0].segments.length,0);assert.equal((await collect(empty,async()=>{throw new Error('must not read');},{expectedModules:[{key:'planning',schemaVersion:4}]}))[0].kind,'complete');
});
test('finished cursors are context-bound and do not let a client skip verification',async()=>{
 const f=await fixture(),all=await collect(f.manifest,f.readSegment),last=all.at(-1);assert.equal(last?.kind,'complete');if(!last)throw new Error('missing fixture completion');const checkpoint=last.cursor as RecoveryCursor;let reads=0;
 const resumed=await collect(f.manifest,async(module,index)=>{reads++;return f.readSegment(module,index);},{resume:{cursor:checkpoint,trustedCheckpoint:checkpoint}});assert.equal(resumed.length,1);assert.equal(resumed[0].kind,'complete');assert.ok(reads>0);
});

test('Unicode IDs follow SQLite UTF8 binary order and retain original text',async()=>{
 const rows=[await row('\uE000',{text:'BMP identifier'}),await row('😀',{text:'supplementary identifier'})],segments=new Map<string,string>();
 const manifest=await encodeRecoverySegments({context,modules:[{key:'planning',schemaVersion:4,rows}],onSegment:async value=>{segments.set(value.module+':'+value.index,value.content);}});
 const decoded=await collect(manifest,async(module,index)=>segments.get(module+':'+index)!,{expectedModules:[{key:'planning',schemaVersion:4}]});
 assert.deepEqual(decoded.filter(value=>value.kind==='row').map(value=>value.row.id),['\uE000','😀']);
});

test('canonical manifest representation rejects duplicate fields and invalid UTF8',async()=>{
 const f=await fixture(),serialized=canonical(f.manifest);
 await assert.rejects(validateRecoveryManifest(serialized.replace('"version":2','"version":1,"version":2'),context,expectedModules),/manifest-encoding/);
 await assert.rejects(validateRecoveryManifest(new Uint8Array([0xff]),context,expectedModules),/encoding/);
 const segments:string[]=[];
 const again=await encodeRecoverySegments({context,segmentBytes:1024,modules:[{...expectedModules[0],rows:[await row('original-a',{text:'مرحباこんにちは"\\'.repeat(12)}),await row('original-b',{text:'مرحباこんにちは"\\'.repeat(12)}),await row('original-c',{text:'مرحباこんにちは"\\'.repeat(12)})]},{...expectedModules[1],rows:[await row('workspace',{schemaVersion:4,title:'Synthetic only'})]}],onSegment:async value=>{segments.push(value.content);}});
 assert.equal(canonical(again),serialized);assert.deepEqual(segments,[...f.segments.values()]);
});
