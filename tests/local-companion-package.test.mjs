import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCandidateBuildPath} from '../lib/release-package-policy.ts';
import {buildLocalCompanionArchive,COMPANION_SOURCE_PATHS} from '../scripts/package-local-companion.mjs';
import {readFile} from 'node:fs/promises';
import {crc32} from 'node:zlib';
test('only the exact reviewed helper asset has an archive path exception',()=>{
 assert.equal(validateCandidateBuildPath('dist/client/control-room-companion.zip'),'dist/client/control-room-companion.zip');
 for(const path of ['dist/client/other.zip','dist/server/control-room-companion.zip','dist/client/assets/control-room-companion.zip'])assert.throws(()=>validateCandidateBuildPath(path));
});
test('download includes exactly reviewed source bytes and a valid stored ZIP central directory',async()=>{
 const {archive}=await buildLocalCompanionArchive();let offset=0;const names=[];
 while(archive.readUInt32LE(offset)===0x04034b50){const size=archive.readUInt32LE(offset+18),length=archive.readUInt16LE(offset+26),extra=archive.readUInt16LE(offset+28),name=archive.subarray(offset+30,offset+30+length).toString(),start=offset+30+length+extra,data=archive.subarray(start,start+size);names.push(name);assert.equal(crc32(data),archive.readUInt32LE(offset+14));const source=name==='Start-ControlRoomCompanion.ps1'?'scripts/start-local-companion.ps1':name;assert.deepEqual(data,await readFile(new URL('../'+source,import.meta.url)));offset=start+size;}
 assert.equal(archive.readUInt32LE(offset),0x02014b50);assert.deepEqual(names.sort(),[...COMPANION_SOURCE_PATHS,'Start-ControlRoomCompanion.ps1'].sort());assert.equal(archive.readUInt32LE(archive.length-22),0x06054b50);assert.equal(archive.readUInt16LE(archive.length-12),names.length);assert.equal(archive.readUInt32LE(archive.length-6),offset);
});
