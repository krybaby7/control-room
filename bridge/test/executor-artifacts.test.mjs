import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openExecutionArtifacts} from '../executor/artifacts.mjs';
test('immutable original artifact bytes survive exact retry and changed same-ID data is rejected',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-artifacts-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await openExecutionArtifacts({directory}),input={id:'fixture-report',filename:'report.json',contentType:'application/json',data:Buffer.from('{"synthetic":true}\n')},descriptor=await store.put(input);assert.deepEqual(await store.read(descriptor.id,descriptor.sha256,descriptor.bytes),input.data);assert.deepEqual(await store.put(input),descriptor);await assert.rejects(store.put({...input,data:Buffer.from('different')}),/identity_differs/);assert.deepEqual(await readFile(join(directory,input.id)),input.data);
 await writeFile(join(directory,input.id),'corrupt');await assert.rejects(store.read(descriptor.id,descriptor.sha256,descriptor.bytes),/identity_differs/);
});
test('artifact capacity never evicts existing data or accepts executable/path names',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-artifacts-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await openExecutionArtifacts({directory}),data=Buffer.alloc(10*1024*1024,65);await store.put({id:'full-fixture',filename:'report.txt',contentType:'text/plain',data});await assert.rejects(store.put({id:'overflow-fixture',filename:'other.txt',contentType:'text/plain',data:Buffer.from('x')}),/capacity/);assert.equal((await readFile(join(directory,'full-fixture'))).length,data.length);await assert.rejects(store.put({id:'../escape',filename:'script.exe',contentType:'application/octet-stream',data:Buffer.alloc(0)}));await assert.rejects(store.put({id:'script-fixture',filename:'script.exe',contentType:'application/octet-stream',data:Buffer.alloc(0)}),/invalid_value/);
});

test('Windows reserved names and alternate streams are rejected on every host',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-artifacts-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await openExecutionArtifacts({directory});for(const id of ['CON','NUL.txt','fixture:stream','trailing.'])await assert.rejects(store.put({id,filename:'report.txt',contentType:'text/plain',data:Buffer.from('x')}),/unsafe_file_identity/);
});
