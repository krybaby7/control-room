import {canonicalMkdtemp as mkdtemp,unitPrivateStateVerifier} from './fixtures/private-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {rm,readFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createArtifactUploadTransport,openArtifactUploadJournal,uploadAttemptArtifacts} from '../executor/artifact-upload.mjs';
import {sha} from '../executor/codec.mjs';
const ownerContextHash='9'.repeat(64);
const identity={jobId:'synthetic-job',attemptId:'synthetic-attempt',deviceId:'synthetic-device',epoch:2,specSha256:'a'.repeat(64)},auth={attemptId:identity.attemptId,leaseToken:'b'.repeat(64)};
const data=Buffer.from('{"summary":"Synthetic result"}'),descriptor={id:'result-synthetic',filename:'inspection.json',contentType:'application/json',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),relativePath:'artifacts/result-synthetic'};
const journal={snapshot:()=>({identity,records:[{entry:{kind:'artifact',value:descriptor}},{entry:{kind:'result',value:{artifactIds:[descriptor.id]}}}]})},artifacts={read:async()=>Buffer.from(data)};
const ingressAdapter={getHeaders:async()=>({headers:{'x-synthetic-ingress':'isolated-test'},expiresAt:'2099-01-01T00:00:00.000Z'})};
function response(action,payload,remote,status='committed'){
 const command=action==='reserve'?{type:'jobs.artifact.reserve',value:{filename:payload.filename,mimeType:payload.mimeType,expectedBytes:payload.expectedBytes},logicalType:payload.logicalType,sha256:payload.sha256}:{type:'jobs.artifact.finalize',id:payload.id};
 return {status,receipt:{mutationId:payload.mutationId,commandHash:sha({protocolVersion:1,command}),appliedRevision:payload.revision+1},currentRevision:payload.revision+1,artifact:remote};
}
test('HTTP lost reserve and finalize replay exact durable intents, remote refs verified, no completion',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-artifact-upload-'));let mappings;
 const requests=[],reserves=new Map(),finalizes=new Map();let issued=0,revision=1,reserveLost=false,stageLost=false,finalizeLost=false;
 const remote={id:'11111111-1111-4111-8111-111111111111',status:'reserved',filename:descriptor.filename,mimeType:'application/json',expectedBytes:data.length,declaredSha256:descriptor.sha256,logicalType:'summary'};
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);requests.push(req.url);
  assert.equal(req.headers['x-control-room-device'],'synthetic-device-key');assert.equal(req.headers.cookie,undefined);assert.equal(req.headers['x-synthetic-ingress'],'isolated-test');
  if(req.method==='PUT'){
   assert.equal(req.url,'/api/bridge/jobs/artifacts/'+remote.id+'/content');assert.equal(req.headers['x-control-room-attempt'],auth.attemptId);assert.equal(req.headers['x-control-room-lease'],auth.leaseToken);assert.deepEqual(bytes,data);
   if(!stageLost){stageLost=true;res.destroy();return;}
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({status:'staged',id:remote.id,bytes:data.length,sha256:descriptor.sha256,finalized:false}));return;
  }
  const p=JSON.parse(bytes);assert.equal(p.attemptId,auth.attemptId);assert.equal(p.leaseToken,auth.leaseToken);
  let result;
  if(req.url.endsWith('/mutation-id'))result={mutationId:'m1_'+'c'.repeat(32)+'_'+String(++issued).padStart(32,'0'),revision};
  else if(req.url.endsWith('/reserve')){
   if(reserves.has(p.mutationId)){assert.equal(reserves.get(p.mutationId),bytes.toString());result=response('reserve',p,remote,'replayed');}
   else{reserves.set(p.mutationId,bytes.toString());revision++;result=response('reserve',p,remote);}
   if(!reserveLost){reserveLost=true;res.destroy();return;}
  }else if(req.url.endsWith('/finalize')){
   if(finalizes.has(p.mutationId)){assert.equal(finalizes.get(p.mutationId),bytes.toString());result=response('finalize',p,{...remote,status:'ready'},'replayed');}
   else{finalizes.set(p.mutationId,bytes.toString());revision++;result=response('finalize',p,{...remote,status:'ready'});}
   if(!finalizeLost){finalizeLost=true;res.destroy();return;}
  }else throw new Error('Unexpected endpoint');
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const transport=createArtifactUploadTransport({enabled:true,baseUrl:'https://synthetic.invalid',deviceCredential:'synthetic-device-key',ingressAdapter,fetchImpl:(url,init)=>fetch('http://127.0.0.1:'+server.address().port+new URL(url).pathname,init)});
 const upload=()=>uploadAttemptArtifacts({journal,artifacts,mappings,transport,credentials:auth,ownerContextHash});
 try{
  mappings=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});
  await assert.rejects(upload(),/artifact_transport_uncertain/);assert.ok(mappings.snapshot()[descriptor.id].prepare);assert.equal(mappings.snapshot()[descriptor.id].reserved,undefined);
  await mappings.close();mappings=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});
  await assert.rejects(upload(),/artifact_transport_uncertain/);assert.ok(mappings.snapshot()[descriptor.id].reserved);assert.equal(mappings.snapshot()[descriptor.id].staged,undefined);
  await mappings.close();mappings=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});
  await assert.rejects(upload(),/artifact_transport_uncertain/);assert.ok(mappings.snapshot()[descriptor.id].finalize);assert.equal(mappings.snapshot()[descriptor.id].ready,undefined);
  await mappings.close();mappings=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});
  const uploaded=await upload();assert.deepEqual(uploaded.artifactRefs,[{id:remote.id,sha256:descriptor.sha256,bytes:data.length,type:'summary'}]);assert.deepEqual(uploaded.byLocalId[descriptor.id],uploaded.artifactRefs[0]);
  const count=requests.length;assert.deepEqual(await upload(),uploaded);assert.equal(requests.length,count);assert.equal(reserves.size,1);assert.equal(finalizes.size,1);assert.equal(issued,2);assert.equal(requests.some(path=>/complete|accept/u.test(path)),false);
  await assert.rejects(uploadAttemptArtifacts({journal,artifacts,mappings,transport,credentials:auth,ownerContextHash:'8'.repeat(64)}),/upload_owner_differs/);
  const text=await readFile(join(directory,'artifact-upload.ndjson'),'utf8');assert.equal(text.includes(auth.leaseToken),false);assert.equal(text.includes('synthetic-device-key'),false);
  await mappings.close();mappings=null;await assert.rejects(openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash:'8'.repeat(64)}),/upload_journal_corrupt/);mappings=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});
  await assert.rejects(mappings.append({localId:descriptor.id,kind:'prepare',value:{...mappings.snapshot()[descriptor.id].prepare,request:{...mappings.snapshot()[descriptor.id].prepare.request,revision:999}}}),/immutable_upload_mapping/);
 }finally{await mappings?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
test('uploader independently rejects altered bytes and cross-attempt maps before HTTP',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-artifact-upload-'));let maps;try{
  maps=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});let calls=0;const transport={mutationId:async()=>{calls++;throw new Error('unexpected');}};
  await assert.rejects(uploadAttemptArtifacts({journal,artifacts:{read:async()=>Buffer.from('changed')},mappings:maps,transport,credentials:auth,ownerContextHash}),/artifact_identity_differs/);assert.equal(calls,0);
  await assert.rejects(uploadAttemptArtifacts({journal,artifacts,mappings:{...maps,identity:{...identity,epoch:3}},transport,credentials:auth,ownerContextHash}),/upload_attempt_differs/);
  await maps.close();maps=null;await appendFile(join(directory,'artifact-upload.ndjson'),'torn');await assert.rejects(openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash}),/upload_journal_truncated/);
 }finally{await maps?.close();await rm(directory,{recursive:true,force:true});}
});
test('private ingress defaults unavailable and bounds hung responses without retry',async()=>{
 let calls=0;const base={enabled:true,baseUrl:'https://synthetic.invalid',deviceCredential:'synthetic',fetchImpl:async()=>{calls++;return new Response('{}',{headers:{'content-type':'application/json'}});}};
 await assert.rejects(createArtifactUploadTransport(base).mutationId(auth),/private_ingress_unavailable/);assert.equal(calls,0);
 let cancelled=false;const transport=createArtifactUploadTransport({...base,ingressAdapter,requestMs:25,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('{'));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});}});
 await assert.rejects(transport.mutationId(auth),/artifact_transport_uncertain/);assert.equal(calls,1);assert.equal(cancelled,true);
});
test('artifact transport stops on authentication rejection and rejects owner/cookie ingress headers',async()=>{
 let calls=0;const base={enabled:true,baseUrl:'https://synthetic.invalid',deviceCredential:'synthetic',ingressAdapter,fetchImpl:async()=>{calls++;return new Response('{}',{status:401,headers:{'content-type':'application/json'}});}};
 const transport=createArtifactUploadTransport(base);await assert.rejects(transport.mutationId(auth),/agent_authentication_stopped/);await assert.rejects(transport.mutationId(auth),/agent_authentication_stopped/);assert.equal(calls,1);
 for(const header of ['cookie','oai-authenticated-user-id','x-control-room-device','x-control-room-lease','x-forwarded-for']){
  const unsafe=createArtifactUploadTransport({...base,ingressAdapter:{getHeaders:async()=>({headers:{[header]:'synthetic'},expiresAt:'2099-01-01T00:00:00.000Z'})}});await assert.rejects(unsafe.mutationId(auth),/unsafe_ingress_headers/);
 }assert.equal(calls,1);
});
test('patch preserves original bytes and request MIME while verifying server plain-text normalization',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-patch-upload-'));let maps;try{
  maps=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});const patch=Buffer.from('Synthetic diff bytes\n'),d={...descriptor,id:'result-patch',filename:'proposal.diff',contentType:'text/x-diff',bytes:patch.length,sha256:createHash('sha256').update(patch).digest('hex'),relativePath:'artifacts/result-patch'};
  const local={snapshot:()=>({identity,records:[{entry:{kind:'artifact',value:d}},{entry:{kind:'result',value:{artifactIds:[d.id]}}}]})};let issued=0;
  const remote={id:'22222222-2222-4222-8222-222222222222',status:'reserved',filename:'proposal.diff.txt',mimeType:'text/plain',expectedBytes:d.bytes,declaredSha256:d.sha256,logicalType:'patch'};
  const transport={mutationId:async()=>({mutationId:'m1_'+'d'.repeat(32)+'_'+String(++issued).padStart(32,'0'),revision:issued}),reserve:async p=>{assert.equal(p.filename,'proposal.diff');assert.equal(p.mimeType,'text/x-diff');return response('reserve',p,remote);},stage:async p=>{assert.equal(p.mimeType,'text/plain');assert.deepEqual(p.bytes,patch);return {status:'staged',id:remote.id,bytes:d.bytes,sha256:d.sha256,finalized:false};},finalize:async p=>response('finalize',p,{...remote,status:'ready'})};
  const result=await uploadAttemptArtifacts({journal:local,artifacts:{read:async()=>patch},mappings:maps,transport,credentials:auth,ownerContextHash});assert.equal(result.artifactRefs[0].type,'patch');
 }finally{await maps?.close();await rm(directory,{recursive:true,force:true});}
});
