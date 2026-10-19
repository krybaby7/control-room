import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,lstat,realpath,readFile,open} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {validateRelativePath,resolveAllowedPath} from '../src/execution-policy.mjs';
import {alias,fileKey,fail,shape} from './codec.mjs';
import {parsePatchPaths} from './operations.mjs';
const exec=promisify(execFile),MAX_FILES=2000,MAX_BYTES=8*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function directory(path){if(!isAbsolute(path)||path.startsWith('\\\\')||/[\r\n\0]/u.test(path))fail('unsafe_local_directory');let cursor=path;for(;;){const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe_local_directory');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}if(await realpath(path)!==path)fail('noncanonical_local_directory');}
function permitted(repo,path){validateRelativePath(path);const compare=value=>process.platform==='win32'?value.toLowerCase():value,p=compare(path),inside=base=>p===compare(base)||p.startsWith(compare(base)+'/');return repo.allowedPaths.some(inside)&&!repo.protectedPaths.some(inside);}
function environment(){const result={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL'])if(process.env[key])result[key]=process.env[key];return {...result,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1'};}
/** A fixed Git reader/materializer. Constructor arguments are trusted LOCAL registration,
 * never cloud-provided paths or executables. It grants no runtime sandbox authority. */
export async function createWorkspaceManager({gitExecutable,repository,stateRoot,verifyPrivateWorkspace}){
 if(!isAbsolute(gitExecutable)||/[\r\n\0]/u.test(gitExecutable))fail('invalid_git_executable');const gitStat=await lstat(gitExecutable);if(!gitStat.isFile()||gitStat.isSymbolicLink())fail('invalid_git_executable');
 shape(repository,['root','allowedPaths','protectedPaths','baseCommits','operations']);await directory(repository.root);await directory(stateRoot);
 if(!Array.isArray(repository.allowedPaths)||!repository.allowedPaths.length||!Array.isArray(repository.protectedPaths)||!Array.isArray(repository.baseCommits))fail('invalid_repository');
 repository.allowedPaths.forEach(validateRelativePath);repository.protectedPaths.forEach(validateRelativePath);
 const gitDirectory=join(repository.root,'.git');const gitDirectoryStat=await lstat(gitDirectory);if(!gitDirectoryStat.isDirectory()||gitDirectoryStat.isSymbolicLink())fail('linked_or_bare_repository_unsupported');await directory(gitDirectory);
 const roots=join(stateRoot,'worktrees');let rootsCreated=false,hooksCreated=false;await mkdir(roots,{mode:0o700}).then(()=>{rootsCreated=true;}).catch(error=>{if(error.code!=='EEXIST')throw error;});await directory(roots);const hooks=join(stateRoot,'empty-hooks');await mkdir(hooks,{mode:0o700}).then(()=>{hooksCreated=true;}).catch(error=>{if(error.code!=='EEXIST')throw error;});await directory(hooks);if(verifyPrivateWorkspace){await verifyPrivateWorkspace(roots,{created:rootsCreated});await verifyPrivateWorkspace(hooks,{created:hooksCreated});}
 const attributes=join(stateRoot,'empty-attributes');let file;try{file=await open(attributes,'wx',0o600);await file.sync();}catch(error){if(error.code!=='EEXIST')throw error;const stat=await lstat(attributes);if(!stat.isFile()||stat.isSymbolicLink()||(await readFile(attributes)).length!==0)fail('unsafe_empty_attributes');}finally{await file?.close();}
 if(verifyPrivateWorkspace)await verifyPrivateWorkspace(stateRoot);
 async function git(cwd,args,maxBuffer=MAX_BYTES){try{const result=await exec(gitExecutable,['-c','core.hooksPath='+hooks,'-c','core.fsmonitor=false','-c','core.attributesFile='+attributes,'-c','core.pager=cat','-c','diff.external=','-C',cwd,...args],{shell:false,windowsHide:true,encoding:'buffer',timeout:15000,maxBuffer,env:environment()});return result.stdout;}catch{fail('fixed_git_operation_failed');}}
 const top=(await git(repository.root,['rev-parse','--show-toplevel'],4096)).toString('utf8').trim();if(await realpath(top)!==repository.root)fail('repository_identity_differs');
 try{if((await readFile(join(gitDirectory,'info','attributes'))).length)fail('repository_attributes_unsupported');}catch(error){if(error.code!=='ENOENT')throw error;}
 async function prepare({workspaceKey,baseCommit}){
  alias(workspaceKey);fileKey(workspaceKey);if(!repository.baseCommits.includes(baseCommit)||! /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit))fail('base_commit_not_registered');
  if((await git(repository.root,['rev-parse','--verify',baseCommit+'^{commit}'],4096)).toString('utf8').trim()!==baseCommit)fail('base_commit_differs');
  const records=(await git(repository.root,['ls-tree','-rz','--full-tree',baseCommit])).toString('utf8').split('\0').filter(Boolean);if(records.length>MAX_FILES)fail('workspace_file_limit');
  const selected=[];let total=0;
  for(const record of records){const match=/^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t(.+)$/u.exec(record);if(!match)fail('invalid_git_tree');const [,mode,type,objectId,path]=match;validateRelativePath(path);if(path.split('/').some(part=>part.toLowerCase()==='.gitattributes'))fail('repository_attributes_unsupported');if(!permitted(repository,path))continue;if(type!=='blob'||!['100644','100755'].includes(mode))fail('symlink_or_submodule_unsupported');const data=await git(repository.root,['cat-file','blob',objectId]);total+=data.length;if(total>MAX_BYTES)fail('workspace_byte_limit');selected.push({path,data,sha256:hash(data)});}
  if(!selected.length)fail('empty_allowed_workspace');
  const root=join(roots,workspaceKey);try{await lstat(root);fail('workspace_already_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  await git(repository.root,['worktree','add','--detach','--no-checkout',root,baseCommit]);await directory(root);
  const marker=await readFile(join(root,'.git'));await git(root,['read-tree',baseCommit]);
  for(const item of selected){const target=join(root,...item.path.split('/'));await mkdir(dirname(target),{recursive:true,mode:0o700});await directory(dirname(target));const fd=await open(target,'wx',0o600);try{await fd.writeFile(item.data);await fd.sync();}finally{await fd.close();}}
  if(verifyPrivateWorkspace)await verifyPrivateWorkspace(root,{created:true});
  return Object.freeze({workspaceKey,baseCommit,root,files:selected.map(({path,sha256,data})=>({path,sha256,bytes:data.length,lineCount:data.toString('utf8').split('\n').length})),limitations:['Only registered allowed paths were materialized. Original uncommitted files were not copied. No runtime sandbox or process ownership has been established.'],async checkPatch(data,outputBytesLimit){if(verifyPrivateWorkspace)await verifyPrivateWorkspace(root);const paths=parsePatchPaths(data,repository,outputBytesLimit);await directory(root);if(!marker.equals(await readFile(join(root,'.git'))))fail('worktree_marker_changed');for(const path of paths){const target=join(root,...path.split('/'));await directory(dirname(target));try{const stat=await lstat(target);if(!stat.isFile()||stat.isSymbolicLink())fail('unsafe_patch_target');}catch(error){if(error.code!=='ENOENT')throw error;}}const patchPath=join(stateRoot,'patch-'+workspaceKey+'.diff'),fd=await open(patchPath,'wx',0o600);try{await fd.writeFile(data);await fd.sync();}finally{await fd.close();}await git(root,['apply','--check','--cached','--whitespace=error-all',patchPath]);return {paths,sha256:hash(data),bytes:data.length,validatedAgainst:baseCommit,applied:false};},async verify(){await directory(root);if(verifyPrivateWorkspace)await verifyPrivateWorkspace(root);if(!marker.equals(await readFile(join(root,'.git'))))fail('worktree_marker_changed');for(const item of selected){const target=await resolveAllowedPath({...repository,root},item.path);const stat=await lstat(target);if(!stat.isFile()||stat.isSymbolicLink())fail('workspace_entry_changed');}return true;}});
 }
 return Object.freeze({prepare});
}
