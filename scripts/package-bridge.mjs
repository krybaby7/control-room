// Build a source-identified, dependency-free Windows-installable package on the cloud runner.
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),output=join(root,'release','bridge');
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:10000,shell:false});
const sourceCommit=git.stdout?.trim();if(git.status!==0||!/^[a-f0-9]{40}$/.test(sourceCommit??''))throw new Error('Exact Git source identity is required.');
const expectedSource=process.env.CONTROL_ROOM_SOURCE_COMMIT??process.env.GITHUB_SHA;if(expectedSource&&expectedSource!==sourceCommit)throw new Error('Cloud checkout identity differs.');
const clean=spawnSync('git',['diff','--exit-code','HEAD','--','bridge'],{cwd:root,encoding:'utf8',timeout:10000,shell:false});if(clean.status!==0)throw new Error('Bridge source differs from its Git identity.');
const untracked=spawnSync('git',['ls-files','--others','--exclude-standard','--','bridge'],{cwd:root,encoding:'utf8',timeout:10000,shell:false,maxBuffer:1048576});if(untracked.status!==0||untracked.stdout.trim())throw new Error('Untracked bridge files are not accepted.');
const {validateConfig}=await import('../bridge/src/config.mjs');validateConfig(JSON.parse(await readFile(join(root,'bridge','config.example.json'),'utf8')));
await mkdir(output,{recursive:true});
const packed=spawnSync('npm',['pack','./bridge','--ignore-scripts','--json','--pack-destination',output],{cwd:root,encoding:'utf8',timeout:120000,shell:false,maxBuffer:1048576});
if(packed.status!==0)throw new Error('Bridge packaging failed.');
const result=JSON.parse(packed.stdout);if(!Array.isArray(result)||result.length!==1)throw new Error('Unexpected package result.');
const item=result[0];if(!/^control-room-windows-bridge-[0-9.]+\.tgz$/.test(item.filename)||!Array.isArray(item.files)||item.files.length<10||item.files.length>100)throw new Error('Invalid package inventory.');
const allowed=/^(?:package\.json|README\.md|config\.example\.json|src\/[a-z0-9-]+\.mjs|windows\/[a-z0-9-]+\.ps1|executor\/[a-z0-9-]+\.mjs|executor\/README\.md|executor\/config\.example\.json)$/;
let unpackedBytes=0;for(const file of item.files){if(!allowed.test(file.path)||!Number.isSafeInteger(file.size)||file.size<0||(unpackedBytes+=file.size)>128*1024*1024)throw new Error('Unexpected or oversized package file.');}
const bytes=await readFile(join(output,item.filename));if(bytes.length>128*1024*1024)throw new Error('Bridge package exceeds its finite limit.');
// Verify the immutable tarball bytes, not only the mutable working tree. Passing
// the captured archive on stdin also binds the manifest digest to this exact copy.
const files=[];for(const file of [...item.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)){
 const expected=spawnSync('git',['show','HEAD:bridge/'+file.path],{cwd:root,timeout:10000,shell:false,maxBuffer:128*1024*1024});
 if(expected.status!==0)throw new Error('Packed bridge file is not tracked at HEAD.');
 const packedFile=spawnSync('tar',['-xOzf','-','--','package/'+file.path],{input:bytes,timeout:10000,shell:false,maxBuffer:128*1024*1024});
 if(packedFile.status!==0||!packedFile.stdout.equals(expected.stdout))throw new Error('Packed bridge file differs from its Git identity.');
 const current=await readFile(join(root,'bridge',file.path));if(!current.equals(expected.stdout))throw new Error('Bridge source changed during packaging.');
 files.push({path:file.path,bytes:packedFile.stdout.length,sha256:createHash('sha256').update(packedFile.stdout).digest('hex')});
}
for(const required of ['src/cli.mjs','src/credentials.mjs','src/transport.mjs','windows/protect-credential.ps1','windows/run-bridge.ps1','windows/install-task.ps1','windows/uninstall-task.ps1','config.example.json','executor/cli.mjs','executor/runtime.mjs','executor/journal.mjs','executor/config.example.json'])if(!files.some(file=>file.path===required))throw new Error('Required bridge file missing.');
const manifest={format:'control-room-bridge-package',version:1,sourceCommit,filename:item.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),files,acceptance:{automated:'See source-specific CI checks.',windows:'not-run',privateIngress:'unavailable',execution:'disabled'}};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'w'});
console.log('CONTROL_ROOM_BRIDGE_PACKAGE '+JSON.stringify({sourceCommit,filename:manifest.filename,bytes:manifest.bytes,sha256:manifest.sha256,files:files.length}));
