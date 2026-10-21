import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {COMPANION_SOURCE_PATHS} from '../scripts/package-local-companion.mjs';
const linuxPackaging={skip:process.platform!=='linux'?'Actual candidate packaging requires the configured Node 24 Linux cloud runner, GNU tar and POSIX bridge npm execution.':false};
const bridgeFiles=['src/cli.mjs','src/credentials.mjs','src/transport.mjs','windows/protect-credential.ps1','windows/run-bridge.ps1','windows/install-task.ps1','windows/uninstall-task.ps1','config.example.json','executor/cli.mjs','executor/runtime.mjs','executor/journal.mjs','executor/config.example.json'];
const companionDownload='dist/client/control-room-companion.zip';
const buildFiles=['dist/client/index.html','dist/client/.assetsignore','dist/client/.vite/manifest.json','dist/server/.vite/manifest.json','dist/server/BUILD_ID','dist/server/index.js',"dist/server/_next/static/framework~index-D-6f_5YM.js","dist/server/_next/static/framework~index~layout~page~app-page-cache-render~app-page-cache~app-route-handler-dispatch-ckpjv12d.js","dist/server/_next/static/framework~index~page~app-route-handler-dispatch-DZA7q185.js","dist/server/_next/static/framework~index~route~route~route~route~route~route~route~route~layout~page~app-page-cache-~i9a0fqwm-BKqSdTeg.js",companionDownload];
async function fixture(extra?:string){
 const directory=await mkdtemp(join(tmpdir(),'control-room-generated-package-')),root=join(directory,'repo');
 async function put(path:string,body:string|Uint8Array){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),body);}
 for(const path of ['scripts/package-candidate.mjs','scripts/package-bridge.mjs','scripts/package-local-companion.mjs','scripts/start-local-companion.ps1','lib/release-package-policy.ts',...COMPANION_SOURCE_PATHS])await put(path,await readFile(new URL('../'+path,import.meta.url)));
 await put('.gitignore','dist/\nrelease/\n/public/control-room-companion.zip\n');
 for(const path of bridgeFiles)await put('bridge/'+path,path.endsWith('.json')?'{}\n':'// Synthetic package bytes.\n');
 await put('bridge/src/config.mjs','export function validateConfig(value){if(!value||typeof value!=="object")throw Error("Invalid synthetic config");}\n');
 await put('bridge/package.json',JSON.stringify({name:'control-room-windows-bridge',version:'0.0.1',private:true,type:'module',files:['src/*.mjs','windows/*.ps1','config.example.json','executor/*.mjs','executor/config.example.json']},null,2)+'\n');
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000});
 git('init','--quiet');git('add','.');git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Synthetic generated-build package');
 const commit=git('rev-parse','HEAD').trim(),env={...process.env,CONTROL_ROOM_SOURCE_COMMIT:commit};
 const bridge=spawnSync(process.execPath,['scripts/package-bridge.mjs'],{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});assert.equal(bridge.status,0,bridge.stderr);
 for(const path of buildFiles)if(path!==companionDownload)await put(path,path.endsWith('.json')?'{}\n':path.endsWith('.js')?'export const synthetic=true;\n':'Synthetic framework output.\n');
 const companion=spawnSync(process.execPath,['scripts/package-local-companion.mjs'],{cwd:root,env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});assert.equal(companion.status,0,companion.stderr);
 await put(companionDownload,await readFile(join(root,'public/control-room-companion.zip')));
 await put('dist/.openai/hosting.json','{"syntheticPrivateMetadata":"excluded"}\n');
 if(extra)await put(extra,'Synthetic disallowed metadata.\n');
 return {directory,root,commit,run:()=>spawnSync(process.execPath,['scripts/package-candidate.mjs'],{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024})};
}
test('actual candidate archive preserves exact framework metadata and generated chunk names while excluding private build root',linuxPackaging,async()=>{
 const f=await fixture();try{
  const result=f.run();assert.equal(result.status,0,result.stderr);
  const output=join(f.root,'release/candidate'),manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
  assert.equal(manifest.sourceCommit,f.commit);
  for(const path of buildFiles){const entry=manifest.files.find((file:{path:string})=>file.path===path);assert.ok(entry,path);const bytes=await readFile(join(f.root,path));assert.equal(entry.bytes,bytes.length);assert.equal(entry.sha256,createHash('sha256').update(bytes).digest('hex'));}
  assert.ok(!manifest.files.some((file:{path:string})=>file.path.includes('/.openai/')));
  const build=manifest.artifacts.find((artifact:{path:string})=>artifact.path.endsWith('.tar.gz'));assert.ok(build);
  const listing=execFileSync('tar',['-tzf',join(output,build.path)],{encoding:'utf8',timeout:10000});
  for(const path of buildFiles)assert.ok(listing.split('\n').includes('./'+path),path);
  assert.ok(!listing.includes('.openai'));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('actual candidate packaging still refuses private files and unrelated hidden siblings beside allowed generated metadata',linuxPackaging,async()=>{
 for(const path of ['dist/client/.env.production','dist/client/.vite/owner-data.json','dist/server/credentials.json']){
  const f=await fixture(path);try{assert.notEqual(f.run().status,0,path);await assert.rejects(readFile(join(f.root,'release/candidate/manifest.json')));}finally{await rm(f.directory,{recursive:true,force:true});}
 }
});
test('actual candidate packaging rejects a changed companion download even at its exact allowed path',linuxPackaging,async()=>{
 const f=await fixture();try{
  const path=join(f.root,companionDownload),bytes=await readFile(path);bytes[bytes.length-1]^=1;await writeFile(path,bytes);
  const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/Companion download differs from reviewed source inventory/);
  await assert.rejects(readFile(join(f.root,'release/candidate/manifest.json')));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
