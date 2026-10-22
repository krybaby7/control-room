import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,posix} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {HISTORY_COLLECTOR_PATHS,buildHistoryCollectorArchive} from '../scripts/package-history-collector.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'collector-package-'));
 for(const path of HISTORY_COLLECTOR_PATHS){await mkdir(dirname(join(root,'collector',path)),{recursive:true});await writeFile(join(root,'collector',path),await readFile(new URL('../collector/'+path,import.meta.url)));}
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','synthetic package fixture']])execFileSync('git',args,{cwd:root});
 return root;
}
function unzip(bytes){
 const files=new Map();let offset=0;
 while(bytes.readUInt32LE(offset)===0x04034b50){
  assert.equal(bytes.readUInt16LE(offset+8),0);const size=bytes.readUInt32LE(offset+18),length=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
  const name=bytes.subarray(offset+30,offset+30+length).toString(),start=offset+30+length+extra,data=bytes.subarray(start,start+size);
  assert.equal(crc32(data),bytes.readUInt32LE(offset+14));assert.ok(!files.has(name));files.set(name,data);offset=start+size;
 }
 let centralCount=0;
 while(bytes.readUInt32LE(offset)===0x02014b50){const size=bytes.readUInt32LE(offset+24),length=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),name=bytes.subarray(offset+46,offset+46+length).toString();assert.equal(files.get(name)?.length,size);assert.equal(crc32(files.get(name)),bytes.readUInt32LE(offset+16));assert.equal(bytes.readUInt32LE(bytes.readUInt32LE(offset+42)),0x04034b50);centralCount++;offset+=46+length+extra+comment;}
 assert.equal(centralCount,files.size);assert.equal(bytes.readUInt32LE(offset),0x06054b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(bytes.readUInt16LE(bytes.length-12),files.size);return files;
}
test('collector ZIP is deterministic, complete, source identified and contains only inert runtime files',async()=>{
 const root=await fixture();try{
  await mkdir(join(root,'collector','state'));await writeFile(join(root,'collector','state','token.json'),'SYNTHETIC_SECRET_NEVER_PACKAGE');
  const first=await buildHistoryCollectorArchive({rootDirectory:root}),second=await buildHistoryCollectorArchive({rootDirectory:root});
  assert.deepEqual(first.archive,second.archive);assert.equal(first.sha256,sha(first.archive));
  const files=unzip(first.archive),manifest=JSON.parse(files.get('package-manifest.json'));
  assert.equal(first.manifestSha256,sha(files.get('package-manifest.json')));assert.match(manifest.sourceCommit,/^[a-f0-9]{40}$/);assert.equal(manifest.version,'0.1.0');
  assert.deepEqual([...files.keys()].sort(),[...HISTORY_COLLECTOR_PATHS,'package-manifest.json'].sort());assert.ok(!first.archive.includes(Buffer.from('SYNTHETIC_SECRET_NEVER_PACKAGE')));
  for(const entry of manifest.files){assert.equal(entry.sha256,sha(files.get(entry.path)));assert.equal(entry.bytes,files.get(entry.path).length);}
  const extracted=join(root,'extracted');
  for(const [name,data] of files){await mkdir(dirname(join(extracted,name)),{recursive:true});await writeFile(join(extracted,name),data);}
  execFileSync(process.execPath,['--input-type=module','-e',"await import('./src/cli.mjs'); await import('./src/adapters/codex-local.mjs'); await import('./src/adapters/claude-code-local.mjs');"],{cwd:extracted});
  for(const [name,data] of files){if(!name.endsWith('.mjs'))continue;for(const match of data.toString().matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)){const spec=match[1];if(spec.startsWith('node:'))continue;assert.ok(spec.startsWith('.'));assert.ok(files.has(posix.normalize(posix.join(posix.dirname(name),spec))),`${name}: missing ${spec}`);}}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('tracked byte tampering, missing runtime and symlink source fail closed',async()=>{
 const root=await fixture();try{
  const path=join(root,'collector','src','cli.mjs'),original=await readFile(path);await writeFile(path,'tampered');await assert.rejects(buildHistoryCollectorArchive({rootDirectory:root}),/source|tracked|identity/i);
  await writeFile(path,original);await rm(path);await assert.rejects(buildHistoryCollectorArchive({rootDirectory:root}));
  const {symlink}=await import('node:fs/promises');await symlink(join(root,'collector','src','config.mjs'),path);await assert.rejects(buildHistoryCollectorArchive({rootDirectory:root}),/regular|link/i);
 }finally{await rm(root,{recursive:true,force:true});}
});
