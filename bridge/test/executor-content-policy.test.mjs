import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareExecutionArtifactContent,assertExecutionArtifactContent} from '../executor/content-policy.mjs';
import {openExecutionArtifacts} from '../executor/artifacts.mjs';
const encode=value=>new TextEncoder().encode(value),decode=value=>new TextDecoder().decode(value);
test('explicit selected transcript preparation redacts synthetic credentials and preserves original input',()=>{
 const original=encode('Synthetic token Bearer '+'a'.repeat(40)+'\nleaseToken='+ 'b'.repeat(64)),copy=original.slice(),result=prepareExecutionArtifactContent({logicalType:'transcript',bytes:original});
 assert.equal(result.changed,true);assert.deepEqual(original,copy);assert.ok(result.codes.includes('bearer_credential'));assert.ok(result.codes.includes('credential_assignment'));assert.ok(!decode(result.bytes).includes('a'.repeat(40)));assert.doesNotThrow(()=>assertExecutionArtifactContent(result.bytes));assert.match(result.limitation,/does not prove/);
});
test('patch privacy refusal preserves semantics; safe text remains exact and unknown type/invalid UTF8/oversize rejected',()=>{
 const patch=encode('diff --git a/example b/example\n+api_key='+ 'x'.repeat(32));assert.throws(()=>prepareExecutionArtifactContent({logicalType:'patch',bytes:patch}),/sensitive_patch/);
 const bytes=encode('Synthetic Arabic نص <script>plain text</script>');const result=prepareExecutionArtifactContent({logicalType:'patch',bytes});assert.equal(result.changed,false);assert.deepEqual(result.bytes,bytes);
 for(const input of [{logicalType:'shell',bytes},{logicalType:'summary',bytes:new Uint8Array([255])},{logicalType:'summary',bytes:new Uint8Array(10*1024*1024+1)}])assert.throws(()=>prepareExecutionArtifactContent(input));
});
test('durable artifact writer refuses unprepared credentials and writes only explicitly prepared bytes',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-content-policy-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=await openExecutionArtifacts({directory,verifyPrivateState:async()=>true}),bytes=encode('Synthetic Bearer '+'a'.repeat(40));
 await assert.rejects(()=>store.put({id:'artifact-original',filename:'synthetic.txt',contentType:'text/plain',data:bytes}),/sensitive_content/);assert.deepEqual(await readdir(directory),[]);
 const prepared=prepareExecutionArtifactContent({logicalType:'diagnostic',bytes}),descriptor=await store.put({id:'artifact-prepared',filename:'synthetic.txt',contentType:'text/plain',data:prepared.bytes});
 assert.deepEqual(await store.read(descriptor.id,descriptor.sha256,descriptor.bytes),Buffer.from(prepared.bytes));
});
