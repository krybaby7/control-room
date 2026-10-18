import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT,FIXTURE_ORIGIN,WORKER_ORIGIN,parseFixtureArgs,prepareFixtures} from './test-fixtures.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const FIXTURE_REQUEST_TIMEOUT_MS=15_000;
/** The same signal bounds response headers and subsequent JSON/text/binary body reads. */
export function fixtureFetch(input,init={},timeoutMs=FIXTURE_REQUEST_TIMEOUT_MS){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>FIXTURE_REQUEST_TIMEOUT_MS)throw new Error('Invalid fixture request deadline.');
 const timeout=AbortSignal.timeout(timeoutMs),signal=init.signal?AbortSignal.any([init.signal,timeout]):timeout;
 return fetch(input,{...init,signal});
}
export async function requireFreePort(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error(`Fixture port ${port} is occupied.`)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});}
export function fixtureProxy({requestTimeoutMs=FIXTURE_REQUEST_TIMEOUT_MS}={}){
 if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>FIXTURE_REQUEST_TIMEOUT_MS)throw new Error('Invalid fixture proxy deadline.');
 return http.createServer((request,response)=>{
  if(request.headers.host!=='127.0.0.1:4173'){response.writeHead(421).end();return;}
  if(!request.url?.startsWith('/')||request.url.startsWith('//')){response.writeHead(400).end();return;}
  const url=new URL(request.url,FIXTURE_ORIGIN);if(url.origin!==FIXTURE_ORIGIN){response.writeHead(400).end();return;}
  if(url.pathname==='/__test/session'){
   if(request.method!=='POST'||request.headers.origin!==FIXTURE_ORIGIN||!['a','b','expired'].includes(url.searchParams.get('owner'))){response.writeHead(403).end();return;}
   const owner=url.searchParams.get('owner');response.writeHead(204,{'Set-Cookie':`fixture_session=${owner}; HttpOnly; SameSite=Strict; Path=/`,'Cache-Control':'no-store'}).end();return;
  }
  if(url.pathname.startsWith('/__test/')){response.writeHead(404).end();return;}
  const headers={...request.headers,host:'127.0.0.1:4174'};for(const name of Object.keys(headers))if(name.startsWith('oai-authenticated-'))delete headers[name];
  const session=request.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith('fixture_session='))?.slice('fixture_session='.length);
  if(session==='a'||session==='b'){headers['oai-authenticated-user-id']=`synthetic-${session}`;headers['oai-authenticated-user-email']=`synthetic-${session}@example.invalid`;}
  // Preserve external/missing origins so production same-origin checks still reject them.
  if(headers.origin===FIXTURE_ORIGIN)headers.origin=WORKER_ORIGIN;
  const upstream=http.request(new URL(request.url??'/',WORKER_ORIGIN),{method:request.method,headers},incoming=>{const outgoing={...incoming.headers};if(typeof outgoing.location==='string'&&outgoing.location.startsWith(WORKER_ORIGIN))outgoing.location=FIXTURE_ORIGIN+outgoing.location.slice(WORKER_ORIGIN.length);response.writeHead(incoming.statusCode??502,outgoing);incoming.on('error',()=>response.destroy());incoming.pipe(response);});
  const deadline=setTimeout(()=>upstream.destroy(new Error('Synthetic fixture upstream deadline exceeded.')),requestTimeoutMs);
  upstream.setTimeout(requestTimeoutMs,()=>upstream.destroy(new Error('Synthetic fixture upstream socket timed out.')));
  response.once('finish',()=>clearTimeout(deadline));response.once('close',()=>{clearTimeout(deadline);upstream.destroy();});
  upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});request.on('aborted',()=>upstream.destroy());request.pipe(upstream);
 });
}
async function waitReady(child){const deadline=Date.now()+60000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('Fixture worker exited before readiness.');try{const response=await fixtureFetch(`${WORKER_ORIGIN}/api/workspace`,{signal:AbortSignal.timeout(1500)});if(response.status===401)return;}catch{}await pause(200);}throw new Error('Fixture worker readiness timed out.');}
export async function smokeFixture(){
 const headers={cookie:'fixture_session=a',origin:FIXTURE_ORIGIN,'Content-Type':'application/json'};const currentResponse=await fixtureFetch(`${FIXTURE_ORIGIN}/api/workspace`,{headers});if(!currentResponse.ok)throw new Error(`Fixture GET failed ${currentResponse.status}`);const current=await currentResponse.json();
 const body={revision:current.revision,mutationId:crypto.randomUUID(),command:{type:'capture.create',capture:{title:'Synthetic smoke capture',body:'fixture only',projectId:null,kind:'idea',sourceUrl:null}}};
 for(let i=0;i<2;i++){const response=await fixtureFetch(`${FIXTURE_ORIGIN}/api/workspace`,{method:'POST',headers,body:JSON.stringify(body)});if(!response.ok)throw new Error(`Fixture POST/replay failed ${response.status}: ${await response.text()}`);}
 const after=await (await fixtureFetch(`${FIXTURE_ORIGIN}/api/workspace`,{headers})).json();if(after.workspace.captures.filter(row=>row.title==='Synthetic smoke capture').length!==1||after.revision!==current.revision+1)throw new Error('Fixture replay was not exactly once.');
 const denied=await fixtureFetch(`${FIXTURE_ORIGIN}/api/workspace`,{method:'POST',headers:{...headers,origin:'https://foreign.invalid'},body:JSON.stringify(body)});if(denied.status!==403)throw new Error('Fixture proxy weakened the origin check.');
 console.log('Synthetic fixture HTTP GET/POST/replay/CSRF smoke passed.');
}
/** Keep failed HTTP assertions actionable without consuming the caller's response. */
export async function assertFixtureStatus(response,expected,step){
 if(response.status===expected)return;
 let body;try{body=(await response.clone().text()).slice(0,4096);}catch{body='[response body unavailable]';}
 assert.equal(response.status,expected,`${step}: expected HTTP ${expected}, received ${response.status}; response body: ${body||'[empty]'}`);
}
export async function smokeAttachments(){
 const headers={cookie:'fixture_session=a',origin:FIXTURE_ORIGIN,'Content-Type':'application/json'};
 const request=(url,options={})=>fixtureFetch(`${FIXTURE_ORIGIN}${url}`,{...options,headers:{...headers,...options.headers}});
 const json=async url=>{const response=await request(url);assert.equal(response.status,200,await response.clone().text());return response.json();};
 const command=async value=>{const current=await json('/api/workspace');return {revision:current.revision,mutationId:randomUUID(),command:value};};
 const post=body=>request('/api/workspace',{method:'POST',body:JSON.stringify(body)});
 const reserve=async(filename,mimeType,bytes)=>{
  const response=await post(await command({type:'attachment.reserve',value:{filename,mimeType,expectedBytes:bytes.length}}));assert.equal(response.status,200,await response.clone().text());
  const snapshot=await json('/api/evidence');const matches=snapshot.attachments.filter(row=>row.filename===filename);assert.equal(matches.length,1);assert.match(matches[0].id,/^[a-f0-9-]{36}$/);return matches[0];
 };
 const filename=`fixture-${randomUUID()}.txt`,bytes=Buffer.from('Synthetic HTTP R2 fixture body.\n');
 const record=await reserve(filename,'text/plain',bytes),url=`/api/attachments/${record.id}/content`;
 const put=(data,extra={})=>request(url,{method:'PUT',headers:{'Content-Type':'text/plain',...extra},body:data});
 let response=await put(bytes);assert.equal(response.status,200,await response.clone().text());const staged=await response.json();assert.equal(staged.status,'staged');assert.equal(staged.finalized,false);
 await assertFixtureStatus(await request(url),404,'GET staged attachment before finalization (owner A)');
 assert.equal((await json('/api/evidence')).attachments.find(row=>row.id===record.id).status,'reserved');
 response=await put(bytes);assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);
 assert.equal((await put(Buffer.from('Synthetic HTTP R2 fixture body.!'))).status,409);
 assert.equal((await put(bytes,{origin:'https://foreign.invalid'})).status,403);
 await assertFixtureStatus(await put(bytes,{cookie:'fixture_session=b'}),404,'PUT owner A reserved attachment as owner B');
 assert.equal((await put(bytes,{cookie:'fixture_session=expired'})).status,401);
 const finalize=await command({type:'attachment.finalize',id:record.id});
 for(let i=0;i<2;i++){response=await post(finalize);assert.equal(response.status,200,await response.clone().text());}
 assert.equal((await json('/api/workspace')).revision,finalize.revision+1);
 response=await request(url);assert.equal(response.status,200);const downloaded=Buffer.from(await response.arrayBuffer());assert.deepEqual(downloaded,bytes);
 const sha256=createHash('sha256').update(downloaded).digest('hex');assert.equal(sha256,staged.sha256);
 assert.equal(response.headers.get('content-type'),'text/plain');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('cache-control')??'',/no-store/);assert.match(response.headers.get('content-disposition')??'',/^attachment;/);assert.ok(response.headers.get('content-disposition').includes(filename));
 await assertFixtureStatus(await request(url,{headers:{cookie:'fixture_session=b'}}),404,'GET owner A ready attachment as owner B');
 assert.equal((await request(url,{headers:{cookie:'fixture_session=expired'}})).status,401);
 const forgedBytes=Buffer.from('This is a forged PNG body.');const forged=await reserve(`forged-${randomUUID()}.png`,'image/png',forgedBytes);const forgedUrl=`/api/attachments/${forged.id}/content`;
 response=await request(forgedUrl,{method:'PUT',headers:{'Content-Type':'image/png'},body:forgedBytes});assert.equal(response.status,422);assert.equal((await response.json()).finalized,false);
 response=await post(await command({type:'attachment.finalize',id:forged.id}));assert.ok(!response.ok,'A forged PNG cannot finalize');
 await assertFixtureStatus(await request(forgedUrl),404,'GET forged PNG after rejected staging and finalization');assert.equal((await json('/api/evidence')).attachments.find(row=>row.id===forged.id).status,'reserved');
 console.log(`Synthetic fixture HTTP R2 reserve/stage/finalize/replay/download/isolation/forgery smoke passed. bytes=${downloaded.length} sha256=${sha256}`);
}
/** Fixture output contains only isolated synthetic identities/configuration. */
export function fixtureFailure(error,logs){
 const message=error instanceof Error?error.message:String(error);
 return new Error(`${message}\nSynthetic local Worker logs (last 12000 characters):\n${logs.slice(-12000)||'[no Worker output captured]'}`,{cause:error});
}
export async function startFixture(args){
 const {serve,withR2}=parseFixtureArgs(args);await requireFreePort(4173);await requireFreePort(4174);const fixture=await prepareFixtures({withR2});let child;let proxy;let cleaning;let logs='';
 const cleanup=()=>cleaning??=(async()=>{if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}}await fixture.cleanup();})();
 const onSignal=()=>{void cleanup().then(()=>process.exit(0));};process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
 try{
  child=spawn(process.execPath,[fixture.wrangler,'dev','--local','--config',fixture.configPath,'--persist-to',fixture.statePath,'--ip','127.0.0.1','--port','4174','--inspector-port','0','--log-level','debug'],{shell:false,cwd:ROOT,env:fixture.environment,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{logs=(logs+data.toString()).slice(-12000);});child.on('error',error=>{logs+=error.message;});
  await waitReady(child);
  proxy=fixtureProxy();await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(4173,'127.0.0.1',resolve);});
  if(!serve){await smokeFixture();if(withR2)await smokeAttachments();await cleanup();}else{console.log(`Synthetic local fixture ready at ${FIXTURE_ORIGIN}`);await new Promise((resolve,reject)=>{child.once('exit',code=>{if(!cleaning)reject(new Error(`Fixture worker exited ${code}`));else resolve();});});}
 }catch(error){throw fixtureFailure(error,logs);}finally{await cleanup();process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);}
}
if(process.argv[1]===fileURLToPath(import.meta.url))startFixture(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
