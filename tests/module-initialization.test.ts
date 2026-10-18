import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const entries=['planning-module','workspace-references','workspace-handlers','planning-read','workspace-export'] as const;
function freshImport(order:readonly string[]){
 const urls=order.map(name=>new URL(`../lib/${name}.ts`,import.meta.url).href);
 const script=`import assert from 'node:assert/strict';for(const url of ${JSON.stringify(urls)})await import(url);const exports=await import(${JSON.stringify(new URL('../lib/workspace-export.ts',import.meta.url).href)});const planning=await import(${JSON.stringify(new URL('../lib/planning-module.ts',import.meta.url).href)});const references=await import(${JSON.stringify(new URL('../lib/workspace-references.ts',import.meta.url).href)});assert.equal(planning.planningExportAdapters.length,4);assert.equal(references.referenceRegistry.entries().length,4);for(const adapter of planning.planningExportAdapters)assert.equal(exports.exportRegistry.get(adapter.key).schemaVersion,1);`;
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8',timeout:20000});assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,`${order.join(' -> ')} failed in fresh process:\n${child.stderr}`);
}
for(const entry of entries)test(`fresh ${entry} import initializes without registration cycles`,()=>{freshImport([entry]);});
test('fresh registry imports work in forward and reverse entry order without duplicate initialization',()=>{freshImport(entries);freshImport([...entries].reverse());});
