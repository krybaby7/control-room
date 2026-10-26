import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const HISTORY_COLLECTOR_PATHS=Object.freeze([
 'README.md','package.json','src/adapters/claude-code-local.mjs','src/adapters/codex-local.mjs',
 'src/checkpoints.mjs','src/cli.mjs','src/config.mjs','src/credentials.mjs',
 'src/readers/compressed-jsonl.mjs','src/readers/jsonl.mjs','src/readers/normalize.mjs',
 'src/reconcile.mjs','src/spool.mjs','src/transport.mjs','src/watch.mjs','src/windows-private-path.mjs',
 'windows/check-private-path.ps1','windows/private-path-helper.ps1','windows/install-task.ps1','windows/protect-credential.ps1','windows/uninstall-task.ps1'
]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(root,args)=>execFileSync('git',args,{cwd:root,timeout:10000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
function zip(files){
 const local=[],central=[];let offset=0;
 for(const {path,bytes} of files){
  const name=Buffer.from(path),crc=crc32(bytes),header=Buffer.alloc(30),record=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
  record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(0x21,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
  local.push(header,name,bytes);central.push(record,name);offset+=header.length+name.length+bytes.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
/** No config, enrollment, captured roots, state or credential files enter this closed inventory. */
export async function buildHistoryCollectorArchive({rootDirectory=ROOT,expectedSourceCommit}={}){
 const sourceCommit=git(rootDirectory,['rev-parse','HEAD']).toString().trim();
 if(!/^[a-f0-9]{40}$/.test(sourceCommit)||expectedSourceCommit&&sourceCommit!==expectedSourceCommit)throw Error('Collector source identity differs');
 const files=[];let total=0;
 for(const path of HISTORY_COLLECTOR_PATHS){
  const source=join(rootDirectory,'collector',path);
  // Reject linked ancestors too; a package never follows local state into the archive.
  let parent=dirname(source);while(parent!==dirname(parent)){if((await lstat(parent)).isSymbolicLink())throw Error('Collector source link');parent=dirname(parent);}
  const stat=await lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||(total+=stat.size)>8*1024*1024)throw Error('Collector source must be bounded regular files');
  const bytes=await readFile(source),tracked=git(rootDirectory,['show',sourceCommit+':collector/'+path]);
  if(!bytes.equals(tracked)||bytes.length!==stat.size)throw Error('Collector source differs from tracked identity');
  files.push({path,bytes});
 }
 const meta=JSON.parse(files.find(file=>file.path==='package.json').bytes);
 if(meta.version!=='0.1.0'||meta.engines?.node!=='>=24'||Object.keys(meta.dependencies??{}).length||Object.keys(meta.optionalDependencies??{}).length)throw Error('Unsupported dependency-free Node24 collector package');
 const inventory=files.map(({path,bytes})=>({path,bytes:bytes.length,sha256:sha(bytes)}));
 const manifest={format:'control-room-history-collector',codecVersion:1,version:meta.version,node:meta.engines.node,sourceCommit,contentSha256:sha(JSON.stringify(inventory)),files:inventory};
 const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');files.push({path:'package-manifest.json',bytes:manifestBytes});
 const archive=zip(files),filename='control-room-history-collector-'+meta.version+'.zip';
 return {archive,manifest,manifestSha256:sha(manifestBytes),filename,sha256:sha(archive),bytes:archive.length};
}
export async function packageHistoryCollector({destination=join(ROOT,'release/history-collector'),...options}={}){
 const built=await buildHistoryCollectorArchive(options);await mkdir(destination,{recursive:true});
 const {archive,...metadata}=built;await writeFile(join(destination,built.filename),archive);await writeFile(join(destination,'manifest.json'),JSON.stringify(metadata,null,2)+'\n');return metadata;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.length&&(args.length!==2||args[0]!=='--output'))throw Error('Use optional --output <directory>');
 console.log(JSON.stringify(await packageHistoryCollector({...(args.length?{destination:resolve(args[1])}:{}),expectedSourceCommit:process.env.CONTROL_ROOM_SOURCE_COMMIT??process.env.GITHUB_SHA})));
}
