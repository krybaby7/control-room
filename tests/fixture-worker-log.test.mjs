import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixtureWorkerLog} from '../scripts/fixture-worker-log.mjs';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
test('Wrangler cause survives a serialized source line larger than the old tail',()=>{
 const capture=createFixtureWorkerLog(),cause='Error inside ProxyWorker\n  cause: { name: NetworkError, message: Network connection lost. }\n';
 const raw='startup '+'.'.repeat(100000)+'\n'+cause+'bundle: '+'.'.repeat(350000)+'\nterminal error stack\n';
 for(let i=0;i<raw.length;i+=9000)capture.append(Buffer.from(raw.slice(i,i+9000)));
 assert.equal(capture.raw().toString(),raw);assert.ok(!raw.slice(-12000).includes('Network connection lost'));assert.ok(!raw.slice(0,6000).includes('Network connection lost'));assert.match(capture.summary(),/Network connection lost/);assert.ok(capture.summary().length<85000);
});
test('fixture capture remains finite with giant unterminated lines and retains last cause',()=>{
 const capture=createFixtureWorkerLog();capture.append('startup\n');for(let n=0;n<20;n++)capture.append(Buffer.alloc(1024*1024,46));capture.append('\nError: final independent failure\n');
 assert.ok(capture.raw().length<=8*1024*1024);assert.match(capture.raw().toString(),/middle omitted/);assert.match(capture.summary(),/final independent failure/);assert.ok(capture.summary().length<85000);
});
test('a copied fixture harness imports only with its complete tracked log helper closure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-fixture-source-'));
 try{
  for(const name of ['test-worker.mjs','test-fixtures.mjs'])await copyFile(new URL('../scripts/'+name,import.meta.url),join(directory,name));
  const run=()=>spawnSync(process.execPath,['--input-type=module','-e','const m=await import(process.argv[1]);if(m.FIXTURE_REQUEST_TIMEOUT_MS!==15000)process.exit(2);',pathToFileURL(join(directory,'test-worker.mjs')).href],{encoding:'utf8',timeout:2000});
  const missing=run();assert.notEqual(missing.status,0);assert.match(missing.stderr,/ERR_MODULE_NOT_FOUND/);
  await copyFile(new URL('../scripts/fixture-worker-log.mjs',import.meta.url),join(directory,'fixture-worker-log.mjs'));
  const complete=run();assert.equal(complete.status,0,complete.stderr);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('saved synthetic evidence redacts ephemeral Wrangler control credentials',()=>{
 const capture=createFixtureWorkerLog();
 capture.append('Error: proxy data {"MF-Proxy-Shared-Secret":"synthetic-opaque-secret","PROXY_CONTROLLER_AUTH_SECRET":"another-synthetic-secret"}\n');
 assert.ok(!capture.raw().toString().includes('synthetic-opaque-secret'));assert.ok(!capture.summary().includes('another-synthetic-secret'));assert.match(capture.raw().toString(),/redacted/);assert.match(capture.summary(),/Error: proxy data/);
});

test('redaction precedes chunk, capture-edge and giant summary-line truncation',()=>{
 const capture=createFixtureWorkerLog(),secret='SYNTHETIC_SECRET_PREFIX_1234567890_SUFFIX';
 const value='Error: '+'.'.repeat(4194250)+'{"MF-Proxy-Shared-Secret":"'+secret+'"}'+'.'.repeat(9000000)+'\nError: {"PROXY_CONTROLLER_AUTH_SECRET":"'+secret+'"}\n';
 for(let n=0;n<value.length;n+=65536)capture.append(value.slice(n,n+65536));
 const raw=capture.raw().toString(),summary=capture.summary();
 for(const evidence of [raw,summary])for(const fragment of ['SYNTHETIC_SECRET_PREFIX','1234567890_SUFFIX'])assert.ok(!evidence.includes(fragment));
 assert.ok(capture.raw().length<=8*1024*1024);assert.match(summary,/redacted/);
});

test('a control key and its value split across tiny chunks never enter evidence',()=>{
 const capture=createFixtureWorkerLog(),value='Error: {"MF-Proxy-Shared-Secret":"SYNTHETIC_CHUNK_SECRET"}\n';
 for(const char of value)capture.append(char);
 assert.ok(!capture.raw().toString().includes('SYNTHETIC_CHUNK_SECRET'));assert.ok(!capture.summary().includes('SYNTHETIC_CHUNK_SECRET'));
});
