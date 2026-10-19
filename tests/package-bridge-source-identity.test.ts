import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {BRIDGE_03_SOURCE_PATHS} from '../lib/release-package-policy.ts';
const required=['src/cli.mjs','src/credentials.mjs','src/transport.mjs','windows/protect-credential.ps1','windows/run-bridge.ps1','windows/install-task.ps1','windows/uninstall-task.ps1','config.example.json','executor/cli.mjs','executor/runtime.mjs','executor/journal.mjs','executor/config.example.json'];
async function fixture(current=false,extra?:string,missing?:string){
 const directory=await mkdtemp(join(tmpdir(),'control-room-package-identity-')),root=join(directory,'repo');await mkdir(join(root,'scripts'),{recursive:true});
 await mkdir(join(root,'lib'));await writeFile(join(root,'lib/release-package-policy.ts'),await readFile(new URL('../lib/release-package-policy.ts',import.meta.url)));
 await writeFile(join(root,'scripts/package-bridge.mjs'),await readFile(new URL('../scripts/package-bridge.mjs',import.meta.url)));
 for(const path of (current?BRIDGE_03_SOURCE_PATHS.filter(path=>!['package.json','README.md'].includes(path)):required).filter(path=>path!==missing)){await mkdir(dirname(join(root,'bridge',path)),{recursive:true});await writeFile(join(root,'bridge',path),path.endsWith('.json')?'{}\n':'// Synthetic packaging fixture only.\n');}
 await writeFile(join(root,'bridge/src/config.mjs'),'export function validateConfig(value){if(!value||typeof value!=="object")throw Error("Invalid synthetic config");}\n');
 await writeFile(join(root,'bridge/README.md'),'Synthetic package identity fixture.\n');
 if(current){await mkdir(join(root,'.openai'));await writeFile(join(root,'.openai/hosting.json'),JSON.stringify({project_id:'appgprj_'+ '0'.repeat(32)})+'\n');await writeFile(join(root,'bridge/src/site-identity.mjs'),"export const SITE_PROJECT_ID='appgprj_"+'0'.repeat(32)+"',SITE_ORIGIN='https://synthetic.chatgpt.site';\n");}
 await writeFile(join(root,'bridge/package.json'),JSON.stringify({name:'control-room-windows-bridge',version:current?'0.3.0':'0.0.1',private:true,type:'module',files:['src/*.mjs','windows/*.ps1','README.md','config.example.json','executor/*.mjs','executor/config.example.json',...(current?['executor/README.md','executor/launch-config.example.json','windows/owned-process/*']:[])]},null,2)+'\n');
 if(extra){await mkdir(dirname(join(root,'bridge',extra)),{recursive:true});await writeFile(join(root,'bridge',extra),'// Synthetic forbidden private runtime source.\n');}
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000});
 git('init','--quiet');git('add','scripts','bridge','lib');if(current)git('add','.openai');git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Synthetic tracked package');
 const commit=git('rev-parse','HEAD').trim();
 const run=(env:Partial<NodeJS.ProcessEnv>={})=>spawnSync(process.execPath,[join(root,'scripts/package-bridge.mjs')],{cwd:root,env:{...process.env,CONTROL_ROOM_SOURCE_COMMIT:commit,...env},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
 return {directory,root,commit,run};
}
test('actual local npm package contains only HEAD-identical tracked bytes and truthful immutable package hashes',async()=>{
 const f=await fixture();try{
  const result=f.run();assert.equal(result.status,0,result.stderr);
  const output=join(f.root,'release/bridge'),manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8')),archive=await readFile(join(output,manifest.filename));
  assert.equal(manifest.sourceCommit,f.commit);assert.equal(manifest.sha256,createHash('sha256').update(archive).digest('hex'));
  assert.deepEqual(manifest.acceptance,{automated:'See source-specific CI checks.',windows:'not-run',privateIngress:'unavailable',execution:'disabled'});
  for(const file of manifest.files){const expected=execFileSync('git',['show','HEAD:bridge/'+file.path],{cwd:f.root,timeout:10000});assert.equal(file.bytes,expected.length);assert.equal(file.sha256,createHash('sha256').update(expected).digest('hex'));}
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('an untracked allowed-name bridge source file is rejected before npm packaging',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,'bridge/src/extra.mjs'),'// Untracked synthetic source.\n');
  const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/Untracked bridge files are not accepted/);
  await assert.rejects(readFile(join(f.root,'release/bridge/manifest.json')));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('a tracked file changed after the clean check and restored after pack cannot create a false HEAD manifest',async()=>{
 const f=await fixture();try{
  let npmCli:string|undefined;
  for(const entry of (process.env.PATH??'').split(delimiter)){try{npmCli=await realpath(join(entry,'npm'));break;}catch{}}
  assert.ok(npmCli,'the cloud Node fixture requires its installed npm CLI');
  const bin=join(f.directory,'bin');await mkdir(bin);const shim=join(bin,'npm');
  // This is a synthetic local npm race, not a product shell/provider hook.
  await writeFile(shim,'#!/usr/bin/env node\n'+
   'const fs=require("node:fs"),cp=require("node:child_process");const path=process.env.SYNTHETIC_TRACKED_FILE,original=fs.readFileSync(path);let result;try{fs.writeFileSync(path,Buffer.concat([original,Buffer.from("// changed only during pack\\n")]));result=cp.spawnSync(process.execPath,[process.env.SYNTHETIC_NPM_CLI,...process.argv.slice(2)],{encoding:"utf8",timeout:30000});}finally{fs.writeFileSync(path,original);}process.stdout.write(result.stdout??"");process.stderr.write(result.stderr??"");process.exit(result.status??1);\n');
  await chmod(shim,0o700);const tracked=join(f.root,'bridge/src/cli.mjs'),before=await readFile(tracked);
  const result=f.run({PATH:bin+delimiter+process.env.PATH,SYNTHETIC_NPM_CLI:npmCli,SYNTHETIC_TRACKED_FILE:tracked});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Packed bridge file differs from its Git identity/);
  assert.deepEqual(await readFile(tracked),before,'working-tree restoration must not hide the packed mutation');
  await assert.rejects(readFile(join(f.root,'release/bridge/manifest.json')));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

test('actual 0.3 source package includes the exact public helper and executor closure',async()=>{
 const f=await fixture(true);try{const result=f.run();assert.equal(result.status,0,result.stderr);const manifest=JSON.parse(await readFile(join(f.root,'release/bridge/manifest.json'),'utf8'));assert.equal(manifest.filename,'control-room-windows-bridge-0.3.0.tgz');assert.deepEqual(manifest.files.map((file:{path:string})=>file.path).sort(),[...BRIDGE_03_SOURCE_PATHS].sort());}finally{await rm(f.directory,{recursive:true,force:true});}
});
test('actual 0.3 packaging refuses a missing owned helper and tracked private runtime code',async()=>{
 for(const [extra,missing]of [[undefined,'windows/owned-process/Program.cs'],['executor/private-runtime.mjs',undefined]] as const){const f=await fixture(true,extra,missing);try{const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/inventory is invalid/);await assert.rejects(readFile(join(f.root,'release/bridge/manifest.json')));}finally{await rm(f.directory,{recursive:true,force:true});}}
});
