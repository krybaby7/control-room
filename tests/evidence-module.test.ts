import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {ownerReader,type RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import {ExportRegistry,exportWorkspaceBundle,parseWorkspaceBundle,type ImportContext,type WorkspaceBundle} from '../lib/workspace-export.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {versionRowId,portableHeadId} from '../lib/version-identity.ts';
import {evidenceExportAdapters,evidenceReferenceDescriptors,validateEvidenceModuleReferences} from '../lib/evidence-module.ts';
import {prepareAttachmentReservation} from '../lib/attachments.ts';
const now='2026-10-18T12:00:00.000Z';
function registry(){const result=new ExportRegistry();for(const adapter of evidenceExportAdapters)result.register(adapter);return result;}
async function add(db:SqlDatabase,table:RegisteredOwnerTable,id:string,value:unknown,extra:Record<string,string|number|null>={},owner='a'){
 const columns=['user_id','id','row_revision','payload_json','content_hash',...Object.keys(extra)],values=[owner,id,3,JSON.stringify(value),await contentHash(canonical(value)),...Object.values(extra)];await db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...values).run();
}
async function fixture(){const f=database(),planning=createSeedWorkspace(now);for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>planning,now);const logical='e'.repeat(128),task=planning.tasks[0],head={id:logical,currentVersion:2,archivedAt:null};await add(f.db,'evidence_records',logical,head,{current_version:2});
 const attachment=prepareAttachmentReservation('a',{filename:'synthetic.txt',mimeType:'text/plain',expectedBytes:3,uploadMutationId:'synthetic-upload-original'},{bytes:0,files:0},{ownerNamespace:'11111111-1111-4111-8111-111111111111',now,createId:()=>'22222222-2222-4222-8222-222222222222'});await add(f.db,'attachments',attachment.id,attachment);await add(f.db,'attachment_usage','quota',{bytes:3,files:1});
 for(const version of [1,2]){const value={id:logical,version,basis:'owner-statement',scope:'implementation',title:'Synthetic evidence',statement:`Version ${version}`,observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[attachment.id],supersedesVersion:version===1?null:1};await add(f.db,'evidence_versions',await versionRowId(logical,version),value,{evidence_id:logical,version,recorded_at:now});}
 const subject={type:'task',id:task.id};await add(f.db,'evidence_mappings','mapping-original',{subject,evidenceId:logical,sourceTextHash:'a'.repeat(64),evidenceVersion:2});
 await add(f.db,'evidence_links','link-original',{id:'link-original',evidenceId:logical,evidenceVersion:2,subject,requirementId:'requirement-original',relation:'supports'});
 await add(f.db,'evidence_requirements','requirement-original',{id:'requirement-original',subject,label:'Synthetic criterion',scope:'implementation',required:true,maxAgeDays:null,candidate:null,requireAttachment:false,archivedAt:null},{subject_type:'task',subject_id:task.id,label:'Synthetic criterion',scope:'implementation',required:1,require_attachment:0});
 const decisionHead={id:'decision-original',currentVersion:1,archivedAt:null};await add(f.db,'decision_records',decisionHead.id,decisionHead,{current_version:1});await add(f.db,'decision_versions',await versionRowId(decisionHead.id,1),{id:decisionHead.id,version:1,title:'Synthetic decision',question:'What next?',options:[],selectedOptionId:null,rationale:'',status:'draft',decidedAt:null,reviewOn:null,subjects:[subject],evidenceRefs:[{id:logical,version:2}],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null},{decision_id:decisionHead.id,version:1,recorded_at:now,status:'draft'});
 for(const table of ['evidence_records','decisions','evidence_links'] as const)await add(f.db,table,`legacy-${table}`,{text:'Unassessed legacy data preserved'});
 return {...f,planning,logical,attachment};}
const context=(bundle:WorkspaceBundle):ImportContext=>({planning:bundle.planning,modules:bundle.modules});

test('composite adapters roundtrip every physical ID including 128-character logical IDs, exact versions and labelled legacy rows',async()=>{
 const f=await fixture();try{const r=registry(),bundle=await exportWorkspaceBundle(f.db,'a',{registry:r,now:()=>now});parseWorkspaceBundle(bundle,r);assert.ok(bundle.modules.evidence);assert.ok(bundle.modules.decisions);assert.ok(!bundle.modules.evidence_versions);const records=bundle.modules.evidence.records as Array<{id:string;contentHash:string;value:{kind:string;physicalId:string;record:unknown}}>;
 const head=records.find(row=>row.value.kind==='head')!;assert.equal(head.id,await portableHeadId(f.logical));assert.equal(head.value.physicalId,f.logical);assert.ok(records.every(row=>row.id.length<=128));for(const row of records)assert.equal(row.contentHash,await contentHash(canonical(row.value)));
 for(const adapter of evidenceExportAdapters){const split=await adapter.prepareReplace!(context(bundle),bundle.modules[adapter.key].records);assert.deepEqual(split.map(item=>item.table),adapter.tables);for(const physical of split){const source=await ownerReader(f.db,'a').list(physical.table,{limit:200});assert.deepEqual(physical.records.slice().sort((a,b)=>a.id.localeCompare(b.id)),source.map(row=>({id:row.id,value:JSON.parse(row.payload_json)})).sort((a,b)=>a.id.localeCompare(b.id)));}}
 assert.ok(records.some(row=>row.value.kind==='legacy'));const legacyLink=(bundle.modules.evidence_links.records as Array<{value:{kind?:string}}>).find(row=>row.value.kind==='legacy');assert.ok(legacyLink);
 }finally{f.sqlite.close();}
});

test('empty composite split explicitly covers every declared table and missing legacy-optional modules remain readable',async()=>{
 const f=database();try{const planning=createSeedWorkspace(now),ctx:ImportContext={planning,modules:{}};for(const adapter of evidenceExportAdapters){assert.equal(adapter.legacyOptional,true);assert.deepEqual(await adapter.prepareReplace!(ctx,[]),adapter.tables!.map(table=>({table,records:[]})));assert.throws(()=>adapter.parseAndMigrate({schemaVersion:2,records:[]}),/version/);}const r=registry();await loadWorkspace(f.db,'a',()=>planning,now);const bundle=await exportWorkspaceBundle(f.db,'a',{registry:r,now:()=>now});bundle.modules={};bundle.source.sourceHashes={planning:bundle.source.sourceHashes.planning};bundle.source.moduleWatermarks={...bundle.source.sourceHashes};const parsed=parseWorkspaceBundle(bundle,r);assert.equal(Object.keys(parsed.modules).length,evidenceExportAdapters.length);
 }finally{f.sqlite.close();}
});

test('incomplete chains, forged physical IDs and typed-to-legacy downgrades fail closed',async()=>{
 const f=await fixture();try{const bundle=await exportWorkspaceBundle(f.db,'a',{registry:registry(),now:()=>now}),adapter=evidenceExportAdapters.find(row=>row.key==='evidence')!,records=structuredClone(bundle.modules.evidence.records) as Array<{id:string;value:{kind:string;physicalId:string;record:unknown}}>;assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:records.filter(row=>!(row.value.kind==='version'&&(row.value.record as {version:number}).version===1))}),/chain/);
 const forged=structuredClone(records);forged.find(row=>row.value.kind==='version')!.value.physicalId='forged-storage-key';await assert.rejects(async()=>adapter.prepareReplace!(context(bundle),forged),/physical identity/);
 const downgraded=structuredClone(records);downgraded.find(row=>row.value.kind==='head')!.value.kind='legacy';assert.throws(()=>adapter.parseAndMigrate({schemaVersion:1,records:downgraded}),/downgraded/);
 }finally{f.sqlite.close();}
});

test('import references require live subjects and exact evidence versions, with no invented historical tombstones',async()=>{
 const f=await fixture();try{const bundle=await exportWorkspaceBundle(f.db,'a',{registry:registry(),now:()=>now});validateEvidenceModuleReferences(context(bundle));const absent=structuredClone(bundle);absent.planning.tasks=absent.planning.tasks.filter(row=>row.id!==f.planning.tasks[0].id);assert.throws(()=>validateEvidenceModuleReferences(context(absent)),/subject/);
 const wrong=structuredClone(bundle);const row=(wrong.modules.evidence_links.records as Array<{value:{evidenceVersion?:number}}>).find(row=>row.value.evidenceVersion===2)!;row.value.evidenceVersion=99;assert.throws(()=>validateEvidenceModuleReferences(context(wrong)),/Exact evidence version/);
 }finally{f.sqlite.close();}
});

test('reference descriptors use actual typed schemas and reject opaque legacy references',async()=>{
 const f=await fixture();try{const descriptor=(key:RegisteredOwnerTable)=>evidenceReferenceDescriptors.find(row=>row.key===key)!;assert.equal(descriptor('evidence_records').entityKind,'evidence');assert.equal(descriptor('attachments').entityKind,'attachment');assert.throws(()=>descriptor('evidence_records').parse({text:'Opaque legacy'}));assert.throws(()=>descriptor('decisions').parse({text:'Opaque legacy'}),/Legacy/);assert.throws(()=>descriptor('attachment_usage').parse({unknown:'unconfigured'}));assert.deepEqual(descriptor('attachment_usage').references(descriptor('attachment_usage').parse({bytes:3,files:1})),[]);
 const version=JSON.parse((await ownerReader(f.db,'a').list('evidence_versions'))[0].payload_json);const refs=descriptor('evidence_versions').references(descriptor('evidence_versions').parse(version));assert.ok(refs.some(ref=>ref.kind==='evidence'&&ref.id===f.logical));assert.ok(refs.some(ref=>ref.kind==='attachment'&&ref.id===f.attachment.id));
 }finally{f.sqlite.close();}
});

test('bounded composite export pages only the authenticated owner',async()=>{
 const f=database();try{const adapter=evidenceExportAdapters.find(row=>row.key==='evidence')!;for(const owner of ['a','b'])for(let n=0;n<205;n++)await add(f.db,'evidence_records',String(n).padStart(4,'0'),{text:`${owner} only`},{},owner);const records=await adapter.exportRows({db:f.db,userId:'a',sourceRevision:1,query:ownerReader(f.db,'a')});assert.equal(records.length,205);assert.ok(JSON.stringify(records).includes('a only'));assert.ok(!JSON.stringify(records).includes('b only'));}finally{f.sqlite.close();}
});

test('attachment quota is a strict singleton and exactly accounts for charged typed metadata',async()=>{
 const f=await fixture();try{const bundle=await exportWorkspaceBundle(f.db,'a',{registry:registry(),now:()=>now});const wrong=structuredClone(bundle);(wrong.modules.attachment_usage.records[0] as {value:{bytes:number}}).value.bytes=2;assert.throws(()=>validateEvidenceModuleReferences(context(wrong)),/quota differs/);
 const missing=structuredClone(bundle);missing.modules.attachment_usage.records=[];assert.throws(()=>validateEvidenceModuleReferences(context(missing)),/complete quota/);
 const quota=evidenceExportAdapters.find(row=>row.key==='attachment_usage')!;const bad=structuredClone(bundle.modules.attachment_usage.records) as Array<{id:string}>;bad[0].id='forged-ledger';assert.throws(()=>quota.parseAndMigrate({schemaVersion:1,records:bad}),/singleton/);
 const legacy=structuredClone(bundle);const value={kind:'legacy',physicalId:'old-attachment',record:{untyped:'Legacy bytes are unknown'}};legacy.modules.attachments.records.push({id:'old-attachment',rowRevision:1,contentHash:await contentHash(canonical(value)),value});assert.throws(()=>validateEvidenceModuleReferences(context(legacy)),/Legacy attachment quota/);
 }finally{f.sqlite.close();}
});

test('legacy-only attachment metadata remains exportable without guessed bytes or live reference authority',async()=>{
 const f=database();try{await loadWorkspace(f.db,'a',()=>createSeedWorkspace(now),now);const original={name:'Old attachment descriptor',unknownSize:true};await add(f.db,'attachments','old-attachment',original);const bundle=await exportWorkspaceBundle(f.db,'a',{registry:registry(),now:()=>now}),adapter=evidenceExportAdapters.find(row=>row.key==='attachments')!;assert.equal((bundle.modules.attachments.records[0] as {value:{kind:string}}).value.kind,'legacy');assert.deepEqual(await adapter.prepareReplace!(context(bundle),bundle.modules.attachments.records),[{table:'attachments',records:[{id:'old-attachment',value:original}]}]);assert.throws(()=>evidenceReferenceDescriptors.find(row=>row.key==='attachments')!.parse(original));}finally{f.sqlite.close();}
});
