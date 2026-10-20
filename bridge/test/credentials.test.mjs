import {canonicalMkdtemp as mkdtemp} from './fixtures/private-state.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createCredentialStore} from '../src/credentials.mjs';
/** Synthetic pipe transform only: does not claim real Windows DPAPI verification. */
function fakeSpawner(calls,{fail=false}={}){
  return (executable,args,options)=>{
    calls.push({executable,args,options});
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    const input=[];child.stdin.on('data',chunk=>input.push(Buffer.from(chunk)));
    child.stdin.on('end',()=>setImmediate(()=>{
      if(fail){child.stderr.write('Synthetic private failure detail');child.emit('close',1);return;}
      const data=Buffer.concat(input),protect=args.at(-1)==='Protect',output=protect?Buffer.from(data.toString('base64')):Buffer.from(data.toString(),'base64');
      // Split every byte to exercise non-ASCII UTF8 boundaries on unprotect.
      for(const byte of output)child.stdout.write(Buffer.from([byte]));
      child.emit('close',0);
    }));
    return child;
  };
}
test('only encrypted output reaches disk; secrets travel on fixed anonymous pipes rather than argv',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'synthetic-bridge-credential-')),path=join(directory,'credentials.dpapi'),calls=[];
  const value={deviceId:'synthetic-device',credentialId:'synthetic-id',deviceCredential:'synthetic-secret-こんにちは',expiresAt:'2099-01-01T00:00:00Z'};
  try{
    const store=createCredentialStore({path,platform:'win32',spawnImpl:fakeSpawner(calls)});
    assert.equal(await store.load(),null);await store.save(value);const disk=await readFile(path,'utf8');
    assert.equal(disk.includes(value.deviceCredential),false);assert.deepEqual(await store.load(),value);
    assert.equal(calls.length,2);
    for(const call of calls){assert.match(call.executable,/^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);assert.equal(call.options.env.PSModulePath,call.executable.replace(/\\powershell\.exe$/iu,'\\Modules'));assert.equal(Object.keys(call.options.env).filter(k=>k.toLowerCase()==='psmodulepath').length,1);assert.equal(Object.keys(call.options.env).some(k=>k.toLowerCase()==='psexecutionpolicypreference'),false);assert.equal(call.options.shell,false);assert.deepEqual(call.options.stdio,['pipe','pipe','pipe']);assert.equal(call.args.includes(value.deviceCredential),false);assert.ok(call.args.some(argument=>argument.endsWith('protect-credential.ps1')));assert.equal(call.args.at(-2),'-Mode');}
    await store.remove();assert.equal(await store.load(),null);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('unsupported platform and process failure are generic and cannot persist plaintext',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'synthetic-bridge-failure-')),path=join(directory,'credentials.dpapi');
  try{
    let spawned=false;
    await assert.rejects(createCredentialStore({path,platform:'linux',spawnImpl:()=>{spawned=true;}}).save({deviceCredential:'private'}),/windows_current_user_protection_unavailable/);assert.equal(spawned,false);
    await assert.rejects(createCredentialStore({path,platform:'win32',spawnImpl:fakeSpawner([],{fail:true})}).save({deviceCredential:'private'}),error=>error.message==='credential_protection_failed');
    await assert.rejects(readFile(path),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('oversized plaintext is rejected before any child process starts',async()=>{
  let spawned=false;
  await assert.rejects(createCredentialStore({path:'/unused',platform:'win32',spawnImpl:()=>{spawned=true;}}).save({value:'x'.repeat(16384)}),/credential_size_exceeded/);
  assert.equal(spawned,false);
});
