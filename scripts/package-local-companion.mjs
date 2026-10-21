import {readFile,mkdir,writeFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname,relative} from 'node:path';
import {crc32} from 'node:zlib';
const root=fileURLToPath(new URL('../',import.meta.url));
/** Deterministic ZIP with stored UTF-8 entries; fixed source allowlist, no credentials/state. */
export const COMPANION_SOURCE_PATHS=Object.freeze([
 'companion/cli.mjs','companion/codex.mjs','companion/local-registration.mjs',
 'companion/owned-process.ps1','companion/OwnedProcess.cs','companion/README.md',
 'companion/server.mjs','companion/snapshot.mjs','companion/start-companion.ps1',
 'companion/analysis-prompt.mjs','companion/chat-context.mjs','companion/chat-selection.mjs',
 'companion/codex-chat-context.mjs','companion/claude-chat-context.mjs',
 'companion/claude.mjs','companion/analysis-run.mjs','companion/provider-readiness.mjs',
 'companion/personal-connector.mjs','companion/personal-credentials.mjs','companion/personal-credentials.ps1',
 'companion/folder-picker.mjs','companion/folder-picker.ps1','scripts/install-personal-companion.ps1',
 'shared/local-analysis.mjs','shared/local-analysis.d.mts',
]);
export async function buildLocalCompanionArchive(){
 const files=[];
 for(const name of COMPANION_SOURCE_PATHS){const path=join(root,name),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Companion source must be a regular file.');files.push({name,bytes:await readFile(path)});}
 files.push({name:'Start-ControlRoomCompanion.ps1',bytes:await readFile(join(root,'scripts/start-local-companion.ps1'))});
 if(!files.some(file=>file.name==='companion/cli.mjs')||!files.some(file=>file.name==='shared/local-analysis.mjs'))throw new Error('Companion source is incomplete.');
 const local=[],central=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.name),data=file.bytes,crc=crc32(data);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x5d55,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);local.push(header,name,data);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(0x5d55,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);central.push(record,name);offset+=header.length+name.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 const archive=Buffer.concat([...local,directory,end]);return {archive,files:files.length,bytes:archive.length};
}
export async function packageLocalCompanion(destination=join(root,'public/control-room-companion.zip')){
 const {archive,files,bytes}=await buildLocalCompanionArchive();await mkdir(dirname(destination),{recursive:true});await writeFile(destination,archive);return {path:relative(root,destination).replaceAll('\\','/'),files,bytes};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])console.log(JSON.stringify(await packageLocalCompanion()));

