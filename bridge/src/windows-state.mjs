import {spawn} from 'node:child_process';
import {win32} from 'node:path';
import {fileURLToPath} from 'node:url';
const SCRIPT=fileURLToPath(new URL('../windows/protect-state.ps1',import.meta.url));
const POWERSHELL=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
export class WindowsStateError extends Error {constructor(code){super(code);this.name='WindowsStateError';this.code=code;}}
function localPath(value){
 if(typeof value!=='string'||value.length>1024||!/^[A-Za-z]:[\\/]/u.test(value)||/["\u0000-\u001f\u007f]/u.test(value)||value.slice(2).includes(':')||/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(value))throw new WindowsStateError('invalid_private_state_path');
 return win32.normalize(value).replace(/[\\]+$/u,'');
}
/** Fixed Windows ACL operation only. This neither authenticates a remote device
 * nor proves real Windows acceptance. Linux fixtures explicitly do no ACL work.
 * Invoke before reading config, decrypting credentials or opening the spool. */
export async function ensurePrivateWindowsState({configPath,stateDirectory},{platform=process.platform,spawnImpl=spawn,timeoutMs=10000}={}){
 if(platform!=='win32')return {status:'not-applicable',reason:'windows-only'};
 const config=localPath(configPath),state=localPath(stateDirectory);
 if(win32.extname(config).toLowerCase()!=='.json'||state.toLowerCase()!==win32.join(win32.dirname(config),'.control-room-bridge').toLowerCase()||!win32.isAbsolute(POWERSHELL))throw new WindowsStateError('invalid_private_state_path');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new WindowsStateError('invalid_private_state_deadline');
 return new Promise((resolve,reject)=>{
  let child;
  try{child=spawnImpl(POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-File',SCRIPT,'-ConfigPath',config,'-StateDirectory',state],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}
  catch{reject(new WindowsStateError('private_state_unavailable'));return;}
  let done=false,size=0;const chunks=[];
  const fail=()=>{if(done)return;done=true;clearTimeout(timer);child.kill();reject(new WindowsStateError('private_state_unavailable'));};
  const timer=setTimeout(fail,timeoutMs);
  child.on('error',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4096)fail();else chunks.push(Buffer.from(chunk));});
  child.stderr.on('data',()=>{});
  child.on('close',code=>{
   if(done)return;done=true;clearTimeout(timer);
   if(code!==0){reject(new WindowsStateError('private_state_unavailable'));return;}
   try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)).trim());if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==2||value.protected!==true||!Number.isSafeInteger(value.entries)||value.entries<2||value.entries>256)throw new Error();resolve({status:'protected',entries:value.entries});}
   catch{reject(new WindowsStateError('private_state_unavailable'));}
  });
  // No secret or path document on stdin. Only the two validated local paths are
  // fixed named arguments; stdout is a bounded status, never ACLs or file data.
  child.stdin.end();
 });
}
