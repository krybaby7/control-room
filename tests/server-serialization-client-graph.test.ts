import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {build} from 'esbuild';
/** Follow the complete runtime module closure of every declared client entry.
 * Type-only imports are erased by the real TS/JS bundler, and indirect imports
 * are included in its metafile rather than checked by a direct-import grep. */
test('all client runtime import closures exclude server digest capability and node crypto',async()=>{
 const entries:string[]=[];
 for(const directory of ['app','components','hooks','lib'])for(const entry of await readdir(directory,{recursive:true,withFileTypes:true})){
  if(!entry.isFile()||!/[.](?:tsx?|jsx?|mts|mjs)$/u.test(entry.name))continue;
  const path=`${entry.parentPath}/${entry.name}`,source=await readFile(path,'utf8');if(/^\s*['"]use client['"];?/u.test(source))entries.push(path);
 }
 assert.ok(entries.length>20,'real client entries must be found');
 const result=await build({entryPoints:entries,bundle:true,write:false,metafile:true,outdir:'/tmp/control-room-client-closure',platform:'browser',format:'esm',packages:'external',logLevel:'silent'});
 const inputs=Object.keys(result.metafile!.inputs);
 assert.ok(inputs.length>entries.length,'transitive runtime dependencies are followed');
 assert.deepEqual(inputs.filter(path=>path.endsWith('/server/serialization-hash.ts')||path.endsWith('/internal/serialization-hash-state.ts')||path.endsWith('/serialization-hash.ts')),[]);
 for(const input of Object.values(result.metafile!.inputs))assert.deepEqual(input.imports.filter(item=>item.path==='node:crypto'),[]);
});
