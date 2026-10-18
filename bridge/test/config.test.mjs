import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_CONFIG,validateConfig,readConfig,canonicalJson,timestamp} from '../src/config.mjs';
const config=()=>JSON.parse(JSON.stringify(DEFAULT_CONFIG));
test('configuration defaults disabled and rejects authority/endpoints',()=>{
 const value=validateConfig(config());assert.equal(value.pcCommandCenter.enabled,false);assert.ok(value.adapters.every(a=>!a.enabled));
 for(const patch of [{token:'secret'},{path:'C:/private'},{proxy:'https://example.com'}])assert.throws(()=>validateConfig({...config(),...patch}));
 const changed=config();changed.pcCommandCenter.url='http://localhost:1';assert.throws(()=>validateConfig(changed));
 for(const origin of ['http://example.com','https://example.com/','https://user:secret@example.com','https://example.com/path'])assert.throws(()=>validateConfig({...config(),cloudBaseUrl:origin}));
 assert.equal(validateConfig({...config(),cloudBaseUrl:'https://example.com'}).cloudBaseUrl,'https://example.com');
 const enabled=config();enabled.adapters[0].enabled=true;assert.throws(()=>validateConfig(enabled));
});
test('canonical JSON rejects unsafe values and invalid calendar timestamps',()=>{
 assert.equal(canonicalJson({z:1,a:{y:2,b:3}}),'{"a":{"b":3,"y":2},"z":1}');
 assert.throws(()=>canonicalJson(JSON.parse('{"__proto__":{}}')));
 assert.throws(()=>canonicalJson({a:Infinity}));assert.throws(()=>timestamp('2026-02-30T00:00:00Z'));assert.throws(()=>timestamp('2026-01-01T24:00:00Z'));
});
test('configuration reads strict bounded UTF8 from an absolute regular file',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'bridge-config-'));try{
  const path=join(directory,'config.json');await writeFile(path,JSON.stringify(config()));assert.equal((await readConfig(path)).schemaVersion,1);
  await writeFile(path,Buffer.from([0xff]));await assert.rejects(readConfig(path));
  await writeFile(path,' '.repeat(65537));await assert.rejects(readConfig(path));await assert.rejects(readConfig('relative.json'));await assert.rejects(readConfig(directory));
 }finally{await rm(directory,{recursive:true,force:true});}
});
