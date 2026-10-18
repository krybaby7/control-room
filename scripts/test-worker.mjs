import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT,FIXTURE_ORIGIN,WORKER_ORIGIN,parseFixtureArgs,prepareFixtures} from './test-fixtures.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function requireFreePort(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error(`Fixture port ${port} is occupied.`)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});}
export function fixtureProxy(){
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
  const upstream=http.request(new URL(request.url??'/',WORKER_ORIGIN),{method:request.method,headers},incoming=>{const outgoing={...incoming.headers};if(typeof outgoing.location==='string'&&outgoing.location.startsWith(WORKER_ORIGIN))outgoing.location=FIXTURE_ORIGIN+outgoing.location.slice(WORKER_ORIGIN.length);response.writeHead(incoming.statusCode??502,outgoing);incoming.pipe(response);});
  upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});request.on('aborted',()=>upstream.destroy());request.pipe(upstream);
 });
}
async function waitReady(child){const deadline=Date.now()+60000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('Fixture worker exited before readiness.');try{const response=await fetch(`${WORKER_ORIGIN}/api/workspace`,{signal:AbortSignal.timeout(1500)});if(response.status===401)return;}catch{}await pause(200);}throw new Error('Fixture worker readiness timed out.');}
export async function smokeFixture(){
 const headers={cookie:'fixture_session=a',origin:FIXTURE_ORIGIN,'Content-Type':'application/json'};const currentResponse=await fetch(`${FIXTURE_ORIGIN}/api/workspace`,{headers});if(!currentResponse.ok)throw new Error(`Fixture GET failed ${currentResponse.status}`);const current=await currentResponse.json();
 const body={revision:current.revision,mutationId:crypto.randomUUID(),command:{type:'capture.create',capture:{title:'Synthetic smoke capture',body:'fixture only',projectId:null,kind:'idea',sourceUrl:null}}};
 for(let i=0;i<2;i++){const response=await fetch(`${FIXTURE_ORIGIN}/api/workspace`,{method:'POST',headers,body:JSON.stringify(body)});if(!response.ok)throw new Error(`Fixture POST/replay failed ${response.status}: ${await response.text()}`);}
 const after=await (await fetch(`${FIXTURE_ORIGIN}/api/workspace`,{headers})).json();if(after.workspace.captures.filter(row=>row.title==='Synthetic smoke capture').length!==1||after.revision!==current.revision+1)throw new Error('Fixture replay was not exactly once.');
 const denied=await fetch(`${FIXTURE_ORIGIN}/api/workspace`,{method:'POST',headers:{...headers,origin:'https://foreign.invalid'},body:JSON.stringify(body)});if(denied.status!==403)throw new Error('Fixture proxy weakened the origin check.');
 console.log('Synthetic fixture HTTP GET/POST/replay/CSRF smoke passed.');
}
export async function startFixture(args){
 const {serve}=parseFixtureArgs(args);await requireFreePort(4173);await requireFreePort(4174);const fixture=await prepareFixtures();let child;let proxy;let cleaning;
 const cleanup=()=>cleaning??=(async()=>{if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}}await fixture.cleanup();})();
 const onSignal=()=>{void cleanup().then(()=>process.exit(0));};process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
 try{
  child=spawn(process.execPath,[fixture.wrangler,'dev','--local','--config',fixture.configPath,'--persist-to',fixture.statePath,'--ip','127.0.0.1','--port','4174','--inspector-port','0'],{shell:false,cwd:ROOT,env:fixture.environment,stdio:['ignore','pipe','pipe']});let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{logs=(logs+data.toString()).slice(-12000);});child.on('error',error=>{logs+=error.message;});
  try{await waitReady(child);}catch(error){throw new Error(`${error.message}\n${logs}`);}
  proxy=fixtureProxy();await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(4173,'127.0.0.1',resolve);});
  if(!serve){await smokeFixture();await cleanup();}else{console.log(`Synthetic local fixture ready at ${FIXTURE_ORIGIN}`);await new Promise((resolve,reject)=>{child.once('exit',code=>{if(!cleaning)reject(new Error(`Fixture worker exited ${code}`));else resolve();});});}
 }finally{await cleanup();process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);}
}
if(process.argv[1]===fileURLToPath(import.meta.url))startFixture(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
