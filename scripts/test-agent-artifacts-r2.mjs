// Actual isolated Miniflare D1/R2, synthetic device registration/private ingress only.
// No provider/model/process or deployed-ingress availability is claimed.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {artifactSeedFixture,artifactNow} from '../tests/fixtures/agent-artifact.ts';
import {claimAgentJob} from '../lib/agents/store.ts';
import {handleAgentArtifactHttp} from '../lib/agents/artifact-http.ts';
import {attachmentHash,createR2BlobStore,readReadyAttachment} from '../lib/attachments.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {readCurrent} from '../lib/workspace-store.ts';

assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 or newer is required.');
const seed=await artifactSeedFixture(),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated synthetic agent artifact fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,r2Buckets:['BUCKET'],r2Persist:false,cf:false});
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET'),migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();
 for(const name of migrations){const source=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const sql of source.split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();}
 // Copy ONLY this fresh in-memory synthetic preclaim fixture, then claim on actual D1.
 const tables=['workspaces','workspace_source_namespaces','workspace_execution_state','devices','device_runtime','device_credentials','agent_capabilities','workspace_job_intents','agent_jobs','agent_job_state','job_approvals','agent_budgets'];
 for(const table of tables){for(const row of seed.sqlite.prepare('SELECT * FROM '+table).all()){assert.equal(row.user_id,seed.owner);const keys=Object.keys(row);assert.ok(keys.every(key=>/^[a-z_]+$/u.test(key)));await db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>row[key])).run();}}
 const lease=await claimAgentJob(db,seed.principal,{jobId:seed.jobId,journalNonce:'synthetic_actual_d1_artifact_nonce_00000001'},seed.options);assert.ok(lease);
 const before=await readCurrent(db,seed.owner,artifactNow),deps={db,bucket,ingress:seed.ingress,now:()=>artifactNow},credentials={attemptId:lease.attemptId,leaseToken:lease.leaseToken};
 const request=(action,value,extra={})=>new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+action,{method:'POST',headers:{'content-type':'application/json','x-control-room-device':seed.deviceSecret,...extra},body:JSON.stringify(value)});
 const call=async(action,value)=>handleAgentArtifactHttp(action,request(action,value),deps);
 async function issued(){const reply=await call('mutation-id',credentials);assert.equal(reply.status,200);return reply.json();}
 const bytes=new TextEncoder().encode('Synthetic exact private result artifact; no actual Agent Lab execution.\n'),sha256=await attachmentHash(bytes),reservation={...credentials,...await issued(),filename:'synthetic-result.txt',mimeType:'text/plain',expectedBytes:bytes.length,logicalType:'summary',sha256};
 const reserved=await call('reserve',reservation);assert.equal(reserved.status,200);const saved=await reserved.json();assert.equal(saved.status,'committed');assert.equal(saved.artifact.status,'reserved');const id=saved.artifact.id;
 const replay=await call('reserve',reservation);assert.equal(replay.status,200);assert.equal((await replay.json()).status,'replayed');
 const upload=data=>new Request('https://synthetic.example.invalid/api/bridge/jobs/artifacts/'+id+'/content',{method:'PUT',headers:{'x-control-room-device':seed.deviceSecret,'x-control-room-attempt':lease.attemptId,'x-control-room-lease':lease.leaseToken,'content-type':'text/plain','content-length':String(data.length)},body:data});
 const bad=bytes.slice();bad[0]^=1;assert.equal((await handleAgentArtifactHttp('content',upload(bad),deps,id)).status,422);assert.equal((await db.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE user_id=?').bind(seed.owner).first()).n,0);
 const staged=await handleAgentArtifactHttp('content',upload(bytes),deps,id);assert.equal(staged.status,200);assert.equal((await staged.json()).finalized,false);const reservedRow=await ownerReader(db,seed.owner).get('attachments',id);assert.equal(JSON.parse(reservedRow.payload_json).status,'reserved');
 const finalized={...credentials,...await issued(),id},final=await call('finalize',finalized);assert.equal(final.status,200);assert.equal((await final.json()).artifact.status,'ready');const finalReplay=await call('finalize',finalized);assert.equal(finalReplay.status,200);assert.equal((await finalReplay.json()).status,'replayed');
 const record=JSON.parse((await ownerReader(db,seed.owner).get('attachments',id)).payload_json),namespace=await getWorkspaceNamespaces(db,seed.owner),physical=await readReadyAttachment(seed.owner,record,createR2BlobStore(bucket),{ownerNamespace:namespace.blobNamespace,now:artifactNow});assert.deepEqual(physical.bytes,bytes);assert.equal(physical.metadata.sha256,sha256);assert.equal(await ownerReader(db,'foreign-synthetic-owner').get('attachments',id),null);
 // Same-attempt aggregate boundary is checked by actual D1 compiler, not a fake quota object.
 const remaining=10*1024*1024-bytes.length,large={...credentials,...await issued(),filename:'synthetic-finite-quota.txt',mimeType:'text/plain',expectedBytes:remaining,logicalType:'summary',sha256:'a'.repeat(64)},largeReply=await call('reserve',large);assert.equal(largeReply.status,200);const overflow={...credentials,...await issued(),filename:'synthetic-overflow.txt',mimeType:'text/plain',expectedBytes:1,logicalType:'summary',sha256:'b'.repeat(64)};assert.equal((await call('reserve',overflow)).status,409);const fullReplay=await call('reserve',reservation);assert.equal(fullReplay.status,200);assert.equal((await fullReplay.json()).status,'replayed');
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_artifacts WHERE user_id=?').bind(seed.owner).first()).n,2);assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_results WHERE user_id=?').bind(seed.owner).first()).n,0);assert.equal((await db.prepare('SELECT status FROM agent_job_state WHERE user_id=? AND job_id=?').bind(seed.owner,seed.jobId).first()).status,'leased');assert.deepEqual((await readCurrent(db,seed.owner,artifactNow)).workspace,before.workspace);
 // Actual current lease cancellation fences a later PUT before object writes.
 const uploadsBefore=(await db.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE user_id=?').bind(seed.owner).first()).n;await db.prepare('UPDATE agent_job_state SET cancel_requested_at=? WHERE user_id=? AND job_id=?').bind(artifactNow,seed.owner,seed.jobId).run();
 const cancelled=await call('mutation-id',credentials);assert.equal(cancelled.status,409);
 assert.equal((await handleAgentArtifactHttp('content',upload(bytes),deps,id)).status,409);assert.equal((await db.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE user_id=?').bind(seed.owner).first()).n,uploadsBefore);
 console.log(JSON.stringify({storage:'actual-miniflare-d1-r2',migrations:migrations.length,ingress:'synthetic-fixture-only',claim:'actual-d1',artifact:'receipted-reserve-stage-finalize-replay',wrongDigest:'rejected-before-put',quota:'actual-10MiB-aggregate',foreignOwner:'unavailable',planning:'unchanged',runtime:'not-tested',successProof:'not-created'}));
 console.log('PASS actual isolated agent artifact D1/R2 lifecycle; no runtime, provider or deployed ingress claim.');
}finally{seed.sqlite.close();await mf.dispose();}
