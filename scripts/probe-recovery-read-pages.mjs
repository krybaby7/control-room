// Calibration only: actual isolated Miniflare D1, compiled closed helper, no owner records.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {OWNER_TABLES} from '../lib/workspace-modules.ts';
import {buildRecoveryReadPageQueries,readRecoveryReadPages} from '../lib/recoverability-read-pages.ts';
assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node24 required.');
const source=process.env.CONTROL_ROOM_SOURCE_COMMIT??'unrecorded';
if(process.env.CI)assert.match(source,/^[a-f0-9]{40}$/);
const counts=[1,2,3,4,5,6,8,10,12,16,18,19],results=[];
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic closed-query calibration")}}',d1Databases:{DB:'synthetic-recovery-read-calibration'}});
function errorCode(error){
 const text=String(error instanceof Error?error.message:error).toLowerCase();
 if(text.includes('too many terms in compound select'))return 'compound_select_limit';
 if(text.includes('expression tree')||text.includes('parser stack'))return 'expression_depth_limit';
 if(text.includes('too many sql variables')||text.includes('too many parameters'))return 'binding_limit';
 if(text.includes('statement too long')||text.includes('string or blob too big'))return 'sql_size_limit';
 return 'unexpected_query_error';
}
try{
 const db=await mf.getD1Database('DB'),files=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
 for(const name of files)for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
 console.log(JSON.stringify({event:'closed_recovery_probe_environment',source,node:process.version,migrations:files.length,engine:'actual-miniflare-d1',ownerData:'none'}));
 for(const mode of ['physical','physical-and-audit'])for(const branches of counts){
  if(mode==='physical-and-audit'&&branches===1)continue;
  const physical=branches-(mode==='physical-and-audit'?1:0);
  const input={tables:OWNER_TABLES.slice(0,physical).map(table=>({table,after:''})),...(mode==='physical-and-audit'?{audit:{after:'',watermarks:{sources:0}}}:{})};
  const queries=buildRecoveryReadPageQueries('synthetic-calibration-owner',input),metadata={event:'closed_recovery_probe',mode,branches,statements:queries.length,selectTokenCount:queries.map(query=>(query.sql.match(/\bSELECT\b/giu)??[]).length),bindings:queries.map(query=>query.bindings.length),sqlBytes:queries.map(query=>new TextEncoder().encode(query.sql).byteLength)};
  try{
   const page=await readRecoveryReadPages(db,'synthetic-calibration-owner',input);assert.equal(page.physical.size,physical);assert.ok([...page.physical.values()].every(rows=>rows.length===0));if(input.audit)assert.deepEqual(page.auditPage,[]);
   const result={...metadata,accepted:true,error:null};results.push(result);console.log(JSON.stringify(result));
  }catch(error){const result={...metadata,accepted:false,error:errorCode(error)};results.push(result);console.log(JSON.stringify(result));}
 }
 assert.ok(results.some(result=>result.accepted),'At least one native query must execute and decode.');
 assert.ok(results.filter(result=>result.branches===1||result.branches===2).every(result=>result.accepted),'Smallest closed probes must execute and decode.');
 assert.ok(results.every(result=>result.accepted||result.error!=='unexpected_query_error'),'Unexpected query/decoder failure.');
 console.log(JSON.stringify({event:'closed_recovery_probe_complete',source,status:'calibration_complete_not_product_acceptance',accepted:results.filter(result=>result.accepted).map(result=>({mode:result.mode,branches:result.branches})),rejected:results.filter(result=>!result.accepted).map(result=>({mode:result.mode,branches:result.branches,error:result.error}))}));
}finally{await mf.dispose();}
