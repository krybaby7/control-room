import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,isAbsolute,relative,sep} from 'node:path';
import {parseExecutionPolicy,parseCapability,executionPolicySha256} from '../src/execution-policy.mjs';
import {shape,fail,digest,canonical} from './codec.mjs';
import {ensurePrivateWindowsState} from '../src/windows-state.mjs';
import {verifyExecutionDirectory} from './journal.mjs';
import {prepareWindowsExecutorStateDirectory,verifyWindowsExecutorStateDirectory} from './owned-process.mjs';
const keys=['schemaVersion','enabled','policy','installation','helper','providerConfiguration','executableEvidence','stateDirectory','bridgeConfigPath','gitExecutable','capability'];
export function launchLocalPath(value){if(typeof value!=='string'||!isAbsolute(value)||value.startsWith('//')||value.startsWith('\\\\')||/[\u0000-\u001f\u007f"*?<>|]/u.test(value)||value.split(/[\\/]/u).some(part=>part==='.'||part==='..'))fail('invalid_launch_path');return value;}
export function parseLaunchManifest(raw){shape(raw,keys);if(raw.schemaVersion!==1||typeof raw.enabled!=='boolean')fail('invalid_launch_manifest');const parsed={...raw,policy:parseExecutionPolicy(raw.policy)};if(raw.enabled!==parsed.policy.enabled)fail('invalid_launch_manifest');
 if(!raw.enabled){if(keys.filter(key=>!['schemaVersion','enabled','policy'].includes(key)).some(key=>raw[key]!==null))fail('invalid_launch_manifest');return parsed;}
 for(const key of ['stateDirectory','bridgeConfigPath','gitExecutable'])launchLocalPath(raw[key]);
 shape(raw.installation,['directory','expected']);launchLocalPath(raw.installation.directory);const pin=raw.installation.expected;shape(pin,['packageName','packageVersion','sourceCommit','tarballSha256','runtimeVersion','toolPolicy']);if(pin.packageName!=='@agent-lab/subscription-runtime'||pin.packageVersion!=='0.1.0'||! /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pin.sourceCommit))fail('invalid_launch_manifest');digest(pin.tarballSha256);for(const key of ['runtimeVersion','toolPolicy'])if(typeof pin[key]!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(pin[key]))fail('invalid_launch_manifest');
 shape(raw.helper,['executable','sha256']);launchLocalPath(raw.helper.executable);digest(raw.helper.sha256);
 shape(raw.providerConfiguration,['provider','executable','subscriptionOnly','extraUsageOffAttested']);launchLocalPath(raw.providerConfiguration.executable);if(raw.providerConfiguration.provider!==parsed.policy.provider||raw.providerConfiguration.subscriptionOnly!==true||raw.providerConfiguration.extraUsageOffAttested!==true)fail('invalid_launch_manifest');
 shape(raw.executableEvidence,['sha256','version']);digest(raw.executableEvidence.sha256);if(raw.executableEvidence.sha256!==parsed.policy.runtime?.executableSha256||raw.executableEvidence.version!==parsed.policy.runtime?.executableVersion)fail('invalid_launch_manifest');
 parsed.capability=parseCapability(raw.capability);if(parsed.capability.configurationSha256!==executionPolicySha256(parsed.policy)||canonical(parsed.capability.runtime)!==canonical(parsed.policy.runtime))fail('invalid_launch_manifest');return JSON.parse(canonical(parsed));
}
export async function readPrivateLaunchJson(path,maxBytes=524288){launchLocalPath(path);const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>maxBytes||process.platform!=='win32'&&((stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid()))fail('launch_manifest_unverified');const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const opened=await file.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.nlink!==1)fail('launch_manifest_unverified');const data=Buffer.alloc(maxBytes+1);let length=0;while(length<data.length){const {bytesRead}=await file.read(data,length,data.length-length,length);if(!bytesRead)break;length+=bytesRead;}if(length>maxBytes)fail('launch_manifest_unverified');return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(data.subarray(0,length)));}finally{await file.close();}}
/** Fixed local scopes select bounded native immediate inventories. */
export function executorScopeForPath(manifestPath,directory){
 launchLocalPath(manifestPath);launchLocalPath(directory);const parent=dirname(manifestPath),state=join(parent,'.control-room-executor'),workspaces=join(parent,'.control-room-workspaces');
 for(const [root,kind]of [[state,'state'],[workspaces,'workspace']]){
  const path=relative(root,directory);if(path==='..'||path.startsWith('..'+sep)||isAbsolute(path))continue;const parts=path?path.split(sep):[];
  if(kind==='state'){
   if(parts.length===0)return 'state-root';
   if(parts.length===1&&['attempts','reservations','claims'].includes(parts[0]))return parts[0];
   if((parts[0]==='runtime'||/^\.runtime-stage-[a-f0-9-]{36}$/u.test(parts[0]))&&parts.length===1)return 'runtime';
   if((parts[0]==='runtime'||/^\.runtime-stage-[a-f0-9-]{36}$/u.test(parts[0]))&&parts.length===2&&parts[1]==='src')return 'runtime-src';
   if(parts[0]==='attempts'&&/^[a-f0-9]{64}$/u.test(parts[1]??'')&&parts.length===2)return 'attempt';
   if(parts[0]==='attempts'&&/^[a-f0-9]{64}$/u.test(parts[1]??'')&&parts.length===3&&parts[2]==='artifacts')return 'artifacts';
  }else{
   if(parts.length===0)return 'workspace-root';
   if(!/^repo-[a-f0-9]{32}$/u.test(parts[0]??''))continue;
   if(parts.length===1)return 'workspace-repository';
   if(parts.length===2&&parts[1]==='worktrees')return 'workspace-attempts';
   if(parts.length===2&&parts[1]==='empty-hooks')return 'workspace-empty';
   if(parts[1]==='worktrees'&&/^attempt-[a-f0-9]{32}$/u.test(parts[2]??'')&&parts.length===3)return 'workspace-tree';
  }
 }
 fail('invalid_launch_scope');
}
/** The credential/config helper keeps its original 256-entry tree bound.
 * Executor checks select one scope, never all retained attempts/worktree files. */
export async function openLaunchManifest(manifestPath){launchLocalPath(manifestPath);const stateRoot=join(dirname(manifestPath),'.control-room-bridge');await ensurePrivateWindowsState({configPath:manifestPath,stateDirectory:stateRoot});const manifest=parseLaunchManifest(await readPrivateLaunchJson(manifestPath));if(!manifest.enabled)return {manifest,verifyPrivateState:null,verifyPrivateWorkspace:null};
 if(manifest.stateDirectory!==join(dirname(manifestPath),'.control-room-executor')||dirname(manifest.bridgeConfigPath)!==dirname(manifestPath)||manifest.installation.directory!==join(manifest.stateDirectory,'runtime'))fail('invalid_launch_scope');
 const verifyPrivateState=async(directory,{created=false}={})=>{const scope=executorScopeForPath(manifestPath,directory);if(process.platform==='win32'){if(created)await prepareWindowsExecutorStateDirectory(directory,{scope});else await verifyWindowsExecutorStateDirectory(directory,{scope});}};
 await ensurePrivateWindowsState({configPath:manifest.bridgeConfigPath,stateDirectory:stateRoot});
 if(process.platform!=='win32')await verifyExecutionDirectory(dirname(manifestPath));
 if(await realpath(manifestPath)!==manifestPath)fail('invalid_launch_path');return {manifest,verifyPrivateState,verifyPrivateWorkspace:verifyPrivateState};
}
