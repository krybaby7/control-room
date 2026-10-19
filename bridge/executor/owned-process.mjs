import {spawn,execFile} from 'node:child_process';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {isAbsolute,dirname,basename,extname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
import {shape,digest,integer,fail,sha} from './codec.mjs';

const executeFile=promisify(execFile);
async function protectHelperDirectory(directory,{protect=false}={}){
 const system=process.env.SystemRoot??'C:\\Windows',environment={};
 for(const [key,value]of Object.entries(process.env))if(['systemroot','windir','userprofile','localappdata','appdata','temp','tmp','homedrive','homepath','username','userdomain','programdata','programfiles','programfiles(x86)','commonprogramfiles'].includes(key.toLowerCase()))environment[key]=value;
 environment.PSModulePath=win32.join(system,'System32','WindowsPowerShell','v1.0','Modules');environment.Path=win32.join(system,'System32');
 try{const result=await executeFile(win32.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../windows/protect-owned-helper.ps1',import.meta.url)),'-DirectoryPath',directory,...(protect?['-Protect']:[])],{shell:false,windowsHide:true,env:environment,timeout:10000,maxBuffer:4096,encoding:'utf8'});const value=JSON.parse(result.stdout.trim());shape(value,['protected','entries']);if(value.protected!==true||!Number.isInteger(value.entries)||value.entries<2||value.entries>3)throw Error();}catch{fail('owned_helper_acl_unverified');}
}

export async function prepareWindowsOwnedHelperDirectory(directory){if(process.platform!=='win32')fail('windows_owned_process_unavailable');if(typeof directory!=='string'||!isAbsolute(directory)||/[\r\n\0]/u.test(directory))fail('invalid_owned_helper');await protectHelperDirectory(directory,{protect:true});}

const nativeSupervisors=new WeakSet();
export function assertWindowsOwnedProcessSupervisor(owner){if(!nativeSupervisors.has(owner))fail('native_owned_supervisor_required');return owner;}

/** Trusted local native helper registration. No cloud executable/config selector.
 * Job ownership controls process lifetime; it does not establish a sandbox. */
export async function createWindowsOwnedProcessSupervisor({helperExecutable,helperSha256}){
 if(process.platform!=='win32')fail('windows_owned_process_unavailable');
 if(!isAbsolute(helperExecutable)||/[\r\n\0]/u.test(helperExecutable))fail('invalid_owned_helper');digest(helperSha256);
 async function verifyHelper(){
  const directory=dirname(helperExecutable),name=basename(helperExecutable),stem=name.slice(0,-extname(name).length);
  if(extname(name).toLowerCase()!=='.exe')fail('invalid_owned_helper');
  for(let cursor=directory;;){const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe_owned_helper_directory');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
  if((await realpath(directory)).toLowerCase()!==directory.toLowerCase())fail('unsafe_owned_helper_directory');
  // A framework-dependent single-file app embeds its private DLL/config. Never
  // hash only an apphost while accepting mutable sibling application code.
  for(const entry of await readdir(directory)){if(![name,stem+'.pdb'].includes(entry))fail('unexpected_owned_helper_sidecar');const stat=await lstat(join(directory,entry));if(!stat.isFile()||stat.isSymbolicLink())fail('unsafe_owned_helper_entry');}
  await protectHelperDirectory(directory);
  const file=await lstat(helperExecutable);if(!file.isFile()||file.isSymbolicLink()||file.size>32*1024*1024||createHash('sha256').update(await readFile(helperExecutable)).digest('hex')!==helperSha256)fail('owned_helper_identity_differs');
 }
 await verifyHelper();
 let active=false,poisoned=false;
 const supervisor=Object.freeze({async run(request){
  if(active||poisoned)fail('owned_process_slot_unavailable');
  shape(request,['executable','args','cwd','env','input','timeoutMs','outputBytesLimit','signal','onStarted','onStdout','onStderr']);
  for(const key of ['executable','cwd'])if(typeof request[key]!=='string'||!isAbsolute(request[key])||/[\r\n\0]/u.test(request[key]))fail('invalid_owned_request');
  if(!Array.isArray(request.args)||request.args.length>128||request.args.some(value=>typeof value!=='string'||value.includes('\0'))||typeof request.input!=='string'||Buffer.byteLength(request.input)>32768)fail('invalid_owned_request');
  if(!request.env||Object.getPrototypeOf(request.env)!==Object.prototype||Object.keys(request.env).length>256||Object.entries(request.env).some(([key,value])=>!key||/[=\0]/u.test(key)||typeof value!=='string'||value.includes('\0')))fail('invalid_owned_environment');
  integer(request.timeoutMs,1,600000);integer(request.outputBytesLimit,1,2097152);
  if(!(request.signal instanceof AbortSignal)||!['onStarted','onStdout','onStderr'].every(key=>typeof request[key]==='function'))fail('invalid_owned_request');
  if(request.signal.aborted)return {stdout:'',stderr:'',exitCode:null,processExitConfirmed:false,terminationUnconfirmed:false,stopReason:'cancelled'};
  active=true;try{await verifyHelper();}catch(error){active=false;throw error;}
  let child,timer,hardTimer,closed=false,startReceipt=Promise.resolve(),started=false,acknowledged=false,terminal=null,bytes=0,stopReason=null,protocolBad=false,helperBytes=0;
  const stdout=[],stderr=[],supervisorId=randomUUID(),environment={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])environment[key]=process.env[key];
  return await new Promise(resolve=>{
   const stop=reason=>{stopReason??=reason;if(child?.stdin.writable)child.stdin.write('stop\n');};
   const abort=()=>stop('cancelled');
   const finish=async(code)=>{closed=true;clearTimeout(timer);clearTimeout(hardTimer);request.signal.removeEventListener('abort',abort);await startReceipt.catch(()=>{});active=false;const confirmed=terminal!==null&&started&&acknowledged&&!protocolBad&&!pending.trim()&&code===0;poisoned=!confirmed;resolve({stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),exitCode:confirmed?terminal.exitCode:null,processExitConfirmed:confirmed,terminationUnconfirmed:!confirmed,stopReason:stopReason??(confirmed?null:'helper_failed')});};
   try{child=spawn(helperExecutable,[],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:environment});}catch{active=false;poisoned=true;resolve({stdout:'',stderr:'',exitCode:null,processExitConfirmed:false,terminationUnconfirmed:true,stopReason:'helper_failed'});return;}
   child.on('error',()=>{protocolBad=true;});child.once('close',finish);
   request.signal.addEventListener('abort',abort,{once:true});
   child.stderr.on('data',chunk=>{helperBytes+=chunk.length;if(helperBytes>16384){protocolBad=true;stop('helper_failed');}});
   // Limit protocol lines before JSON decode; output is base64 in <=8192 byte chunks.
   let pending='';child.stdout.on('data',chunk=>{pending+=chunk.toString('utf8');if(pending.length>32768&&!pending.includes('\n')){protocolBad=true;stop('helper_failed');pending='';return;}let split;while((split=pending.indexOf('\n'))>=0){const line=pending.slice(0,split);pending=pending.slice(split+1);if(line.length>16384){protocolBad=true;stop('helper_failed');continue;}void consume(line);}});
   async function consume(line){try{
    const row=JSON.parse(line);if(terminal)throw Error();
    if(row.kind==='started'){
     shape(row,['kind','pid','startedAt']);integer(row.pid,1);if(started||!Number.isFinite(Date.parse(row.startedAt)))throw Error();started=true;
     const identity={pid:row.pid,startedAt:row.startedAt,supervisorId,ownershipSha256:sha({helperSha256,supervisorId,pid:row.pid,startedAt:row.startedAt})};
     startReceipt=Promise.resolve().then(()=>request.onStarted(identity));await startReceipt;if(closed||protocolBad)return;if(stopReason||request.signal.aborted){stop('cancelled');return;}acknowledged=true;child.stdin.write('resume\n');
    }else if(['stdout','stderr'].includes(row.kind)){
     shape(row,['kind','data']);if(!acknowledged||typeof row.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row.data))throw Error();
     const data=Buffer.from(row.data,'base64');bytes+=data.length;if(bytes>request.outputBytesLimit){stop('output_limit');return;}
     (row.kind==='stdout'?stdout:stderr).push(data);try{request[row.kind==='stdout'?'onStdout':'onStderr'](data);}catch{stop('helper_failed');}
    }else if(row.kind==='exited'){
     shape(row,['kind','exitCode','processExitConfirmed']);integer(row.exitCode,-2147483648,2147483647);if(!acknowledged||row.processExitConfirmed!==true)throw Error();terminal=row;
    }else{protocolBad=true;stop('helper_failed');}
   }catch{protocolBad=true;stop('helper_failed');}}
   timer=setTimeout(()=>stop('timed_out'),request.timeoutMs);
   hardTimer=setTimeout(()=>{protocolBad=true;stopReason??='helper_failed';child.kill();},request.timeoutMs+30000);
   child.stdin.on('error',()=>{});
   const body=JSON.stringify({executable:request.executable,args:request.args,cwd:request.cwd,env:request.env,input:request.input,timeoutMs:request.timeoutMs});
   if(Buffer.byteLength(body)>1048576){protocolBad=true;child.kill();return;}child.stdin.write(body+'\n');
   if(request.signal.aborted)abort();
  });
 }});
 nativeSupervisors.add(supervisor);return supervisor;
}
