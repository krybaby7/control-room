import test from 'node:test';
import assert from 'node:assert/strict';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import {OWNER_TABLES,ownerReader,type RegisteredOwnerTable,type GuardedWrite} from '../lib/workspace-modules.ts';
import {executeWorkspaceCommand,canonicalJson} from '../lib/workspace-transaction.ts';
import type {AuditEventDraft,JsonValue} from '../lib/workspace-protocol.ts';
import {versionRowId} from '../lib/version-identity.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-owner',hash='a'.repeat(64);
const byteLength=(value:string)=>new TextEncoder().encode(value).length;
async function fixture(){const f=database();await loadWorkspace(f.db,owner,workspaceFixture,now);return f;}
function event(id='event'):AuditEventDraft{return {id,kind:'synthetic.change',entityType:'workspace',entityId:null,changes:[{path:['notes'],before:{exists:false,value:null},after:{exists:true,value:'Unicode العربية 😀, quotes " and backslash \\.'}}],origin:'owner',actorId:owner,occurredAt:now,sourceRef:null,undoOf:null};}
async function add(f:ReturnType<typeof database>,table:RegisteredOwnerTable,id:string,value:JsonValue,sequence?:number){const projection=await moduleProjection(table,id,value),columns=moduleColumnNames(table);if(sequence!==undefined)projection.stream_sequence=sequence;f.sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash${columns.map(c=>','+c).join('')}) VALUES(?,?,1,?,?${columns.map(()=>',?').join('')})`).run(owner,id,canonical(value),await contentHash(canonical(value)),...columns.map(c=>projection[c]));}
test('exact composite export, escaped Unicode audit and normalized mirrors match actual compiler/export without measurement writes',async()=>{
 const f=await fixture();try{
  const version={id:'evidence',version:1,basis:'owner-statement',scope:'implementation',title:'وثيقة 😀',statement:'Quoted "test" and backslash \\',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
  const id=await versionRowId('evidence',1),writes:GuardedWrite[]=[{table:'evidence_records',operation:'insert',id:'evidence',expectedRowRevision:null,value:{id:'evidence',currentVersion:1,archivedAt:null}},{table:'evidence_versions',operation:'insert',id,expectedRowRevision:null,value:version}];
  const events=[event()],changes=f.sqlite.prepare('SELECT total_changes() n').get()!.n;
  const measured=await measureProspectiveRecoverability(f.db,owner,{now,writes,events});assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(measured.measurement.allowed,true);assert.equal(measured.boundaryRevision,1);assert.deepEqual(measured.boundaryWatermarks,{sources:0});assert.deepEqual(measured.boundaryRows.map(row=>row.table),[...OWNER_TABLES]);assert.deepEqual(measured.boundaryRows.find(row=>row.table==='evidence_versions')!.rows,[]);assert.equal(canonical(measured.boundaryRows).includes('payload_json'),false);
  const expanded=[{id,row_revision:1,payload_json:canonical(version),content_hash:await contentHash(canonical(version)),...await moduleProjection('evidence_versions',id,version)}];
  assert.equal(measured.measurement.measurements.tables.find(t=>t.table==='evidence_versions')!.expandedAfterPayloadBytes,byteLength(canonicalJson(expanded)));
  const result=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:'synthetic_measure_0001',command:{type:'fixture'}},{db:f.db,now:()=>now,handlers:new Map([['fixture',{async prepare(context){return {planningAfter:context.before.workspace,writes,events,jobs:[]};}}]])});assert.equal(result.status,'committed');
  const actual=await exportWorkspaceBundle(f.db,owner,{now:()=>now});assert.equal(measured.measurement.measurements.bundleBytes,byteLength(JSON.stringify(actual)));assert.equal(JSON.stringify(actual).includes(owner),false);assert.equal((actual.modules.evidence.records[0] as {value:{kind:string}}).value.kind,'head');
 }finally{f.sqlite.close();}
});
test('historical imports measure exact nested compiler wrapping while duplicate IDs are retained only once in prospective export',async()=>{
 const f=await fixture();try{
  const source={text:'Original "quotation" \\ العربية 😀'},entry={id:'history-synthetic',source,importHash:hash},historyImports=[entry,entry],events=[event('import-event')];
  const measured=await measureProspectiveRecoverability(f.db,owner,{now,events,historyImports});
  const compiled=historyImports.map((item,index)=>({id:item.id,ordinal:events.length+index,payload:canonicalJson({id:item.id,kind:'imported-history',entityType:'historical-claim',entityId:null,changes:[{path:['sourceClaim'],before:{exists:false,value:null},after:{exists:true,value:item.source}}],origin:'owner',actorId:owner,occurredAt:now,sourceRef:item.importHash,undoOf:null})}));
  assert.equal(measured.measurement.measurements.historicalAudit!.compiledWrappedBytes,byteLength(canonicalJson(compiled)));assert.equal(measured.measurement.measurements.historicalAudit!.preparedBytes,byteLength(canonicalJson(historyImports)));
  const result=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:'synthetic_history_0001',command:{type:'fixture'}},{db:f.db,now:()=>now,handlers:new Map([['fixture',{async prepare(context){return {planningAfter:context.before.workspace,writes:[],events,historyImports,jobs:[]};}}]])});assert.equal(result.status,'committed');
  const actual=await exportWorkspaceBundle(f.db,owner,{now:()=>now});assert.equal(actual.modules.audit_events.records.length,2);assert.equal(measured.measurement.measurements.bundleBytes,byteLength(JSON.stringify(actual)));
 }finally{f.sqlite.close();}
});
test('nested history JSON argument can exceed 1.8 MB while prospective portable bundle fits D1',async()=>{
 const f=await fixture();try{const result=await measureProspectiveRecoverability(f.db,owner,{now,historyImports:[{id:'history-large',source:{text:'\\'.repeat(450000)},importHash:hash}]});assert.equal(result.measurement.allowed,false);assert.ok(result.measurement.measurements.bundleBytes!<1800000);assert.ok(result.measurement.measurements.historicalAudit!.compiledWrappedBytes!>1800000);assert.ok(result.measurement.reasons.some(r=>r.scope==='historical-audit:compiled'&&r.code==='sql_argument_bytes'));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get()!.n,0);}finally{f.sqlite.close();}
});
test('full replacement uses physical payload JSON expansion, before hashes and owner-bound current row revisions',async()=>{
 const f=await fixture();try{
  await add(f,'evidence_records','legacy',{text:'previous'});const beforeRows=await ownerReader(f.db,owner).list('evidence_records');
  const records=[{id:'legacy',value:{text:'\\'.repeat(450000)}}];const measured=await measureProspectiveRecoverability(f.db,owner,{now,replacements:[{table:'evidence_records',beforeRows,records}]});
  assert.equal(measured.measurement.allowed,false);assert.deepEqual(measured.boundaryRows.find(row=>row.table==='evidence_records')!.rows,beforeRows.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash})));assert.ok(measured.measurement.measurements.bundleBytes!<1800000);assert.ok(measured.measurement.reasons.some(r=>r.scope==='table:evidence_records:expanded-after'&&r.code==='sql_argument_bytes'));
  assert.equal(measured.measurement.measurements.tables.find(t=>t.table==='evidence_records')!.beforeRowsBytes,byteLength(canonicalJson(beforeRows.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash})))));
  await assert.rejects(measureProspectiveRecoverability(f.db,owner,{now,replacements:[{table:'evidence_records',beforeRows:[{...beforeRows[0],content_hash:hash}],records:[]}]}),/before rows differ/);
  await assert.rejects(measureProspectiveRecoverability(f.db,owner,{now,writes:[{table:'evidence_records',operation:'update',id:'legacy',value:{text:'new'},expectedRowRevision:2}]}),/precondition/);
  assert.equal((await ownerReader(f.db,owner).get('evidence_records','legacy'))!.payload_json,canonical({text:'previous'}));
 }finally{f.sqlite.close();}
});
test('operational source snapshot and stream audit use exact adapters and retain editor revision',async()=>{
 const f=await fixture();try{
  const projectId=workspaceFixture().projects[0].id;await add(f,'source_connections','connection',{id:'connection',provider:'github',label:'Synthetic',accessMode:'interactive',enabled:true,archivedAt:null});await add(f,'source_targets','source',{id:'source',connectionId:'connection',projectId,kind:'github_repository',providerResourceId:'synthetic/repo',canonicalUrl:'https://github.com/synthetic/repo',selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null});
  const payload={excerpt:'Snapshot "quoted" العربية 😀'},observation={id:'observation',sourceId:'source',externalId:'file',sourceRevision:'sha',sourceUpdatedAt:null,observedAt:now,title:'Immutable source',canonicalUrl:null,contentDigest:await contentHash(canonical(payload)),payload,origin:'provider-read'};
  const proposal={id:'proposal',sourceId:'source',observationRefs:[{id:observation.id,contentDigest:observation.contentDigest}],evidenceRefs:[],entity:{kind:'project',id:projectId},baseWorkspaceRevision:1,fields:[{field:'name',before:workspaceFixture().projects[0].name,after:'Suggested name'}],rationale:'Inferred suggestion only.',confidence:'direct-source',createdAt:now,state:'pending',dedupKey:hash,decision:null};
  const opEvent={...event('operational-event'),origin:'connector' as const},options={now,operationalWrites:[{table:'source_observations' as const,value:observation,streamSequence:1},{table:'source_proposals' as const,value:proposal,streamSequence:1}],operationalEvents:[{event:opEvent,streamId:'sources',sequence:1}],operationalWatermarksAfter:{sources:1}};
  const measured=await measureProspectiveRecoverability(f.db,owner,options);assert.equal(measured.measurement.allowed,true);assert.equal(measured.boundaryRevision,1);
  await add(f,'source_observations','observation',observation,1);await add(f,'source_proposals','proposal',proposal);f.sqlite.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,last_sequence,revision) VALUES(?,?,1,1)').run(owner,'sources');f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,NULL,NULL,?,?,?,?,?,?,?)').run(owner,opEvent.id,'sources',1,opEvent.kind,opEvent.entityType,opEvent.entityId,now,canonical(opEvent));
  const actual=await exportWorkspaceBundle(f.db,owner,{now:()=>now});assert.equal(actual.source.workspaceRevision,1);assert.equal(measured.measurement.measurements.bundleBytes,byteLength(JSON.stringify(actual)));assert.equal(actual.modules.source_observations.records.length,1);
  await assert.rejects(measureProspectiveRecoverability(f.db,owner,{now,operationalWatermarksAfter:{sources:0}}),/backwards/);
 }finally{f.sqlite.close();}
});
test('corrupt current physical hashes and missing owners fail closed without repairing or creating records',async()=>{
 const f=await fixture();try{await add(f,'evidence_records','legacy',{text:'unchanged'});f.sqlite.prepare('UPDATE evidence_records SET content_hash=? WHERE user_id=?').run(hash,owner);await assert.rejects(measureProspectiveRecoverability(f.db,owner,{now}),/content hash/);await assert.rejects(measureProspectiveRecoverability(f.db,'foreign-owner',{now}),/could not be loaded/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspaces').get()!.n,1);}finally{f.sqlite.close();}
});
test('ordinary owner audit growth is refused when a future reviewed restore history wrapper would exceed SQL capacity',async()=>{
 const f=await fixture();try{
  const large={...event('escaped-ordinary-event'),changes:[{path:['notes'],before:{exists:false,value:null},after:{exists:true,value:'\\'.repeat(450000)}}]};
  const quote=await measureProspectiveRecoverability(f.db,owner,{now,events:[large]});assert.equal(quote.measurement.allowed,false);assert.ok(quote.measurement.measurements.bundleBytes!<1800000);assert.equal(quote.measurement.measurements.historicalAudit,null);assert.ok(quote.measurement.reasons.some(reason=>reason.code==='sql_argument_bytes'&&reason.scope==='sql:future-restore:history-compiled'));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('future local restore SQL projections include prospective row revision increment across digit boundaries',async()=>{
 const f=await fixture();try{
  await add(f,'evidence_records','legacy',{text:'retained'});f.sqlite.prepare('UPDATE evidence_records SET row_revision=9 WHERE user_id=?').run(owner);
  const quote=await measureProspectiveRecoverability(f.db,owner,{now}),row=(await ownerReader(f.db,owner).get('evidence_records','legacy'))!;
  const expected=canonical([{...row,row_revision:10,...await moduleProjection('evidence_records',row.id,JSON.parse(row.payload_json))}]);
  assert.equal(quote.measurement.measurements.sqlArguments.find(argument=>argument.name==='future-restore:evidence_records:after')!.bytes,byteLength(expected));
  assert.equal(quote.measurement.measurements.sqlArguments.find(argument=>argument.name==='future-restore:evidence_records:after')!.bytes,quote.measurement.measurements.tables.find(table=>table.table==='evidence_records')!.expandedAfterPayloadBytes!+1);
 }finally{f.sqlite.close();}
});
test('aggregate normalized reference rows fail closed across individually bounded portable modules',async()=>{
 const f=await fixture();try{
  const value={text:'Synthetic retained legacy row'},payload=canonical(value),digest=await contentHash(payload);
  for(const [table,count]of [['evidence_records',6000],['decisions',5000]]as const){const insert=f.sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)`);for(let i=0;i<count;i++)insert.run(owner,`synthetic-${String(i).padStart(5,'0')}`,payload,digest);}
  const quote=await measureProspectiveRecoverability(f.db,owner,{now});assert.equal(quote.measurement.allowed,false);assert.equal(quote.measurement.measurements.counts.find(count=>count.name==='normalized-owner-reference-rows')!.rows,11000);assert.ok(quote.measurement.reasons.some(reason=>reason.code==='row_limit'&&reason.scope==='count:normalized-owner-reference-rows'&&reason.actual===11000&&reason.limit===10000));assert.equal(quote.measurement.measurements.counts.find(count=>count.name==='module:evidence')!.rows,6000);assert.equal(quote.measurement.measurements.counts.find(count=>count.name==='module:decisions')!.rows,5000);
 }finally{f.sqlite.close();}
});

function observeDatabase(db:import('../lib/workspace-store.ts').SqlDatabase,afterRead:(sql:string)=>void,afterBatch?:(sqls:readonly string[])=>void):import('../lib/workspace-store.ts').SqlDatabase{
 type Statement=import('../lib/workspace-store.ts').SqlStatement;
 const originals=new WeakMap<Statement,{statement:Statement;sql:string}>();
 return {prepare(sql){let statement=db.prepare(sql);const wrapped:Statement={bind(...values){statement=statement.bind(...values);originals.set(wrapped,{statement,sql});return wrapped;},async first<T>(){const result=await statement.first<T>();afterRead(sql);return result;},async all<T>(){const result=await statement.all<T>();afterRead(sql);return result;},run(){return statement.run();}};originals.set(wrapped,{statement,sql});return wrapped;},async batch(statements){const selected=statements.map(statement=>{const value=originals.get(statement);if(!value)throw new Error('Unknown synthetic statement.');return value;});const result=await db.batch(selected.map(value=>value.statement));afterBatch?.(selected.map(value=>value.sql));for(const value of selected)afterRead(value.sql);return result;}};
}
test('one frozen module capture plus one verification matches actual export without redundant adapter database scans',async()=>{
 const f=await fixture();try{
  await add(f,'evidence_records','legacy',{text:'Exact retained Unicode العربية 😀 and escaping \\"'});
  let reads=0;const db=observeDatabase(f.db,sql=>{if(sql.includes('FROM evidence_records WHERE user_id=(SELECT owner FROM recovery_page_scope) AND id>?'))reads++;});
  const changes=f.sqlite.prepare('SELECT total_changes() n').get()!.n,quote=await measureProspectiveRecoverability(db,owner,{now});
  assert.equal(reads,2,'One physical capture and one final equality check; adapters read only the frozen image.');
  const actual=await exportWorkspaceBundle(f.db,owner,{now:()=>now});assert.equal(quote.measurement.measurements.bundleBytes,byteLength(JSON.stringify(actual)));
  assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,changes);
 }finally{f.sqlite.close();}
});
test('normalized insert or payload change after capture cannot certify a mixed frozen image',async()=>{
 for(const change of ['insert','update']as const){const f=await fixture();try{
  await add(f,'evidence_records','legacy',{text:'Original immutable measurement input'});let raced=false;
  const replacement=canonical({text:'Changed after first physical capture'}),digest=await contentHash(replacement);
  const db=observeDatabase(f.db,sql=>{if(!raced&&sql.includes('FROM evidence_records WHERE user_id=(SELECT owner FROM recovery_page_scope) AND id>?')){raced=true;if(change==='insert')f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(owner,'new-direct-row',replacement,digest);else f.sqlite.prepare('UPDATE evidence_records SET payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(replacement,digest,owner,'legacy');}});
  await assert.rejects(measureProspectiveRecoverability(db,owner,{now}),/row set changed/);assert.equal(raced,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}}
});
test('same-revision audit insertion after capture is rejected rather than omitted from recovery measurement',async()=>{
 const f=await fixture();try{
  let raced=false;const entry=event('late-native-audit');
  const db=observeDatabase(f.db,sql=>{if(!raced&&sql.includes('FROM audit_events WHERE user_id=')&&sql.includes('event_id>?')){raced=true;f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,0,?,?,?,?,?)').run(owner,entry.id,entry.kind,entry.entityType,entry.entityId,now,canonical(entry));}});
  await assert.rejects(measureProspectiveRecoverability(db,owner,{now}),/Audit row set changed/);assert.equal(raced,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('frozen measurement detects an audit namespace change and never rotates it itself',async()=>{
 const f=await fixture();try{
  const replacement=crypto.randomUUID();let raced=false;
  const db=observeDatabase(f.db,sql=>{if(!raced&&sql.includes('FROM evidence_records WHERE user_id=(SELECT owner FROM recovery_page_scope) AND id>?')){raced=true;f.sqlite.prepare('UPDATE workspace_source_namespaces SET audit_namespace=? WHERE user_id=?').run(replacement,owner);}});
  await assert.rejects(measureProspectiveRecoverability(db,owner,{now}),/Audit namespace changed/);
  assert.equal(f.sqlite.prepare('SELECT audit_namespace FROM workspace_source_namespaces WHERE user_id=?').get(owner)!.audit_namespace,replacement);
 }finally{f.sqlite.close();}
});

test('closed batched pages retain all 450 immutable rows and exact key cursors with no unrelated-owner mixing',async()=>{
 const f=await fixture();try{
  const payload=canonical({text:'Retained synthetic paginated metadata'}),digest=await contentHash(payload),insert=f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)');
  for(let index=0;index<450;index++)insert.run(owner,'paged-'+String(index).padStart(4,'0'),payload,digest);
  let pages=0;const db=observeDatabase(f.db,sql=>{if(sql.includes('FROM evidence_records WHERE user_id=(SELECT owner FROM recovery_page_scope) AND id>?'))pages++;});
  const quote=await measureProspectiveRecoverability(db,owner,{now});assert.equal(pages,6);assert.equal(quote.boundaryRows.find(row=>row.table==='evidence_records')!.rows.length,450);
  assert.equal(quote.measurement.measurements.bundleBytes,byteLength(JSON.stringify(await exportWorkspaceBundle(f.db,owner,{now:()=>now}))));
 }finally{f.sqlite.close();}
});
test('missing or malformed batch row results fail closed rather than certifying an empty recovery image',async()=>{
 for(const mode of ['missing','shape','order']as const){const f=await fixture();try{
  const original=f.db.batch.bind(f.db),sqlByStatement=new WeakMap<import('../lib/workspace-store.ts').SqlStatement,string>();let tampered=false;
  const db:import('../lib/workspace-store.ts').SqlDatabase={prepare(sql){const statement=f.db.prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){const result=await original(statements);if(!tampered&&statements.some(statement=>sqlByStatement.get(statement)?.startsWith('WITH recovery_page_scope'))){tampered=true;if(mode==='missing')return result.map(row=>({meta:row.meta}));const row={id:'bad',row_revision:1,payload_json:'{}',content_hash:hash};result[0].results=mode==='shape'?[{...row,unexpected:true}]:[row,row];}return result;}};
  await assert.rejects(measureProspectiveRecoverability(db,owner,{now}),/closed recovery|snapshot batch|snapshot row/);assert.equal(tampered,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}}
});

test('mixed BMP and astral original IDs retain SQLite BINARY order in real export and both frozen recovery passes',async()=>{
 const f=await fixture();try{
  const ids=['unicode-\uE000','unicode-\u{10000}'];
  for(const id of ids){
   await add(f,'evidence_records',id,{id,currentVersion:1,archivedAt:null});
   await add(f,'evidence_versions',await versionRowId(id,1),{id,version:1,basis:'owner-statement',scope:'implementation',title:'Literal Unicode original identity',statement:'Retained original ID; no rewriting.',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null});
  }
  const stored=f.sqlite.prepare('SELECT id FROM evidence_records WHERE user_id=? ORDER BY id').all(owner).map(row=>row.id);assert.deepEqual(stored,ids);assert.notDeepEqual([...ids].sort(),ids);
  const actual=await exportWorkspaceBundle(f.db,owner,{now:()=>now}),quote=await measureProspectiveRecoverability(f.db,owner,{now});
  assert.deepEqual(quote.boundaryRows.find(row=>row.table==='evidence_records')!.rows.map(row=>row.id),ids);
  assert.equal(quote.measurement.measurements.bundleBytes,byteLength(JSON.stringify(actual)));
  for(const id of ids)assert.ok(actual.modules.evidence.records.some(raw=>(raw as {value?:{record?:{id?:string}}}).value?.record?.id===id));
 }finally{f.sqlite.close();}
});

test('one flat materialized page statement per read-only batch retain independent physical-and-audit pagination',async()=>{
 const f=await fixture();try{
  let sizes:number[]=[];const db=observeDatabase(f.db,()=>{},sqls=>{if(sqls.some(sql=>sql.startsWith('WITH recovery_page_scope'))){assert.ok(sqls.every(sql=>sql.startsWith('WITH recovery_page_scope')));sizes.push(sqls.length);}});
  const empty=await measureProspectiveRecoverability(db,owner,{now});assert.deepEqual(sizes,[1,1,1,1]);assert.equal(empty.measurement.allowed,true);
  const payload=canonical({text:'Exact bounded independent cursor'}),digest=await contentHash(payload),insert=f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)');
  for(let index=0;index<450;index++)insert.run(owner,'wide-page-'+String(index).padStart(4,'0'),payload,digest);
  insert.run('different-owner','foreign-not-selected',payload,digest);sizes=[];
  const quote=await measureProspectiveRecoverability(db,owner,{now});assert.deepEqual(sizes,[1,1,1,1,1,1,1,1]);
  assert.equal(quote.boundaryRows.find(row=>row.table==='evidence_records')!.rows.length,450);assert.equal(canonical(quote.boundaryRows).includes('foreign-not-selected'),false);
  assert.equal(quote.measurement.measurements.bundleBytes,byteLength(JSON.stringify(await exportWorkspaceBundle(f.db,owner,{now:()=>now}))));
 }finally{f.sqlite.close();}
});
test('actual Miniflare D1 accepts a single flat materialized page read statement without dropping owner rows or final equality proofs',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readFile,readdir}=await import('node:fs/promises'),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic recovery batch fixture")}}',d1Databases:{DB:'synthetic-wide-recovery'}});
 try{
  const native=await mf.getD1Database('DB'),files=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
  for(const name of files)for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await native.prepare(sql.trim()).run();
  await loadWorkspace(native,owner,workspaceFixture,now);
  const payload=canonical({text:'Retained actual D1 original Unicode العربية 😀'}),digest=await contentHash(payload);
  for(const [user,id]of [[owner,'native-selected'],['different-owner','native-foreign']]as const)await native.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(user,id,payload,digest).run();
  const sizes:number[]=[];const db=observeDatabase(native,()=>{},sqls=>{if(sqls.some(sql=>sql.startsWith('WITH recovery_page_scope'))){assert.ok(sqls.every(sql=>sql.startsWith('WITH recovery_page_scope')));sizes.push(sqls.length);}});
  const quote=await measureProspectiveRecoverability(db,owner,{now});assert.deepEqual(sizes,[1,1,1,1]);assert.equal(quote.measurement.allowed,true);
  assert.deepEqual(quote.boundaryRows.find(row=>row.table==='evidence_records')!.rows.map(row=>row.id),['native-selected']);
  assert.equal(quote.measurement.measurements.bundleBytes,byteLength(JSON.stringify(await exportWorkspaceBundle(native,owner,{now:()=>now}))));
  assert.equal((await native.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').bind(owner).first<{n:number}>())!.n,0);
 }finally{await mf.dispose();}
});

test('co-batched audit and normalized pages retain every independent cursor, exact export and foreign-owner isolation',async()=>{
 const f=await fixture();try{
  const payload=canonical({text:'Independent physical cursor'}),digest=await contentHash(payload),insert=f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)');
  const insertAudit=f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,?,?,?,?,?,?)');
  for(let index=0;index<450;index++){
   insert.run(owner,'physical-'+String(index).padStart(4,'0'),payload,digest);
   const entry=event('audit-'+String(index).padStart(4,'0'));insertAudit.run(owner,entry.id,index,entry.kind,entry.entityType,entry.entityId,now,canonical(entry));
  }
  insert.run('foreign-owner','foreign-physical',payload,digest);const foreign=event('foreign-audit');insertAudit.run('foreign-owner',foreign.id,0,foreign.kind,foreign.entityType,foreign.entityId,now,canonical(foreign));
  const sizes:number[]=[];let auditReads=0;
  const db=observeDatabase(f.db,sql=>{if(sql.includes('FROM audit_events WHERE user_id=')&&sql.includes('event_id>?'))auditReads++;},sqls=>{
   if(sqls.some(sql=>sql.startsWith('WITH recovery_page_scope'))){assert.ok(sqls.every(sql=>sql.startsWith('WITH recovery_page_scope')));sizes.push(sqls.length);}
  });
  const changes=f.sqlite.prepare('SELECT total_changes() n').get()!.n,quote=await measureProspectiveRecoverability(db,owner,{now});
  assert.deepEqual(sizes,[1,1,1,1,1,1,1,1]);assert.equal(auditReads,6);
  assert.equal(quote.boundaryRows.find(row=>row.table==='evidence_records')!.rows.length,450);
  const bundle=await exportWorkspaceBundle(f.db,owner,{now:()=>now});assert.equal(bundle.modules.audit_events.records.length,450);
  assert.equal(quote.measurement.measurements.bundleBytes,byteLength(JSON.stringify(bundle)));
  assert.equal(canonical(quote.boundaryRows).includes('foreign-physical'),false);assert.equal(JSON.stringify(bundle).includes('foreign-audit'),false);
  assert.equal(f.sqlite.prepare('SELECT total_changes() n').get()!.n,changes);
 }finally{f.sqlite.close();}
});
test('missing, oversized or repeated co-batched audit rows fail closed without certifying a physical-only image',async()=>{
 for(const mode of ['missing','oversized','repeated','shape','primitive']as const){const f=await fixture();try{
  const statements=new WeakMap<import('../lib/workspace-store.ts').SqlStatement,string>(),original=f.db.batch.bind(f.db);let tampered=false;
  const db:import('../lib/workspace-store.ts').SqlDatabase={prepare(sql){const statement=f.db.prepare(sql);statements.set(statement,sql);return statement;},async batch(selected){
   const result=await original(selected),index=selected.findIndex(statement=>statements.get(statement)?.includes('FROM audit_events WHERE user_id=(SELECT owner FROM recovery_page_scope) AND event_id>?'));
   if(!tampered&&index>=0){tampered=true;const entry=event('bad-audit'),row={event_id:entry.id,workspace_revision:1,ordinal:0,stream_id:null,stream_sequence:null,kind:entry.kind,entity_type:entry.entityType,entity_id:entry.entityId,occurred_at:now,payload_json:canonical(entry)};
    if(mode==='missing')return result.map((value,i)=>i===index?{meta:value.meta}:value);
    result[index].results=mode==='oversized'?Array.from({length:201},()=>row):mode==='shape'?[{...row,unexpected:true}]:mode==='primitive'?[null]:[row,row];
   }return result;
  }};
  await assert.rejects(measureProspectiveRecoverability(db,owner,{now}),/closed recovery|audit snapshot|pagination order/);assert.equal(tampered,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations').get()!.n,0);
 }finally{f.sqlite.close();}}
});

