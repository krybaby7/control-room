import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,unlink,mkdir,stat} from 'node:fs/promises';
import {dirname,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const POWERSHELL=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const SCRIPT=fileURLToPath(new URL('../windows/protect-credential.ps1',import.meta.url));
export class CredentialError extends Error {constructor(code){super(code);this.name='CredentialError';this.code=code;}}
export function createCredentialStore({path,platform=process.platform,spawnImpl=spawn}){
  async function transform(mode,value){
    if(platform!=='win32'||!win32.isAbsolute(POWERSHELL))throw new CredentialError('windows_current_user_protection_unavailable');
    if(Buffer.byteLength(value)>(mode==='Protect'?16384:65536))throw new CredentialError('credential_size_exceeded');
    return new Promise((resolve,reject)=>{
      let child;
      try{child=spawnImpl(POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-File',SCRIPT,'-Mode',mode],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}
      catch{reject(new CredentialError('credential_protection_failed'));return;}
      const chunks=[];let size=0,done=false;
      const fail=()=>{if(done)return;done=true;clearTimeout(timer);child.kill();reject(new CredentialError('credential_protection_failed'));};
      const timer=setTimeout(fail,10000);
      child.on('error',fail);child.stdin.on('error',fail);
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>65536)fail();else chunks.push(Buffer.from(chunk));});
      child.stderr.on('data',()=>{});
      child.on('close',code=>{
        if(done)return;done=true;clearTimeout(timer);
        if(code!==0){reject(new CredentialError('credential_protection_failed'));return;}
        try{const output=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(mode==='Unprotect'&&Buffer.byteLength(output)>16384)throw new Error();resolve(output);}
        catch{reject(new CredentialError('credential_protection_failed'));}
      });
      child.stdin.end(value);
    });
  }
  return Object.freeze({
    async save(value){
      const encrypted=(await transform('Protect',JSON.stringify(value))).trim();
      if(!/^[A-Za-z0-9+/]+={0,2}$/u.test(encrypted))throw new CredentialError('invalid_protected_credential');
      await mkdir(dirname(path),{recursive:true,mode:0o700});
      const temporary=path+'.'+randomUUID()+'.tmp';
      try{await writeFile(temporary,encrypted,{mode:0o600,flag:'wx'});await rename(temporary,path);}
      finally{await unlink(temporary).catch(()=>{});}
    },
    async load(){
      let encrypted;
      try{if((await stat(path)).size>65536)throw new CredentialError('credential_size_exceeded');encrypted=await readFile(path,'utf8');}
      catch(error){if(error.code==='ENOENT')return null;throw new CredentialError('credential_read_failed');}
      if(Buffer.byteLength(encrypted)>65536||!/^[A-Za-z0-9+/]+={0,2}$/u.test(encrypted))throw new CredentialError('invalid_protected_credential');
      try{return JSON.parse(await transform('Unprotect',encrypted));}catch{throw new CredentialError('credential_read_failed');}
    },
    async remove(){await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw new CredentialError('credential_remove_failed');});}
  });
}
