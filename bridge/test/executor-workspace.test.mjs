import {canonicalMkdtemp as mkdtemp} from './fixtures/private-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {executorScopeForPath} from '../executor/launch-config.mjs';
import {tmpdir} from 'node:os';
import {createWorkspaceManager} from '../executor/workspace.mjs';
import {parsePatchPaths,validateInspectionReport} from '../executor/operations.mjs';
const exec=promisify(execFile),git='/usr/bin/git';
async function fixture(t){
 if(process.platform!=='linux'){t.skip('Fixed synthetic Git fixture is exercised on Linux Actions; Windows acceptance remains NOT RUN');return null;}try{await stat(git);}catch{t.skip('Pinned Linux Git fixture executable is unavailable');return null;}
 const root=await mkdtemp(join(tmpdir(),'executor-workspace-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'repo'),state=join(root,'state');await mkdir(repo,{mode:0o700});await mkdir(state,{mode:0o700});
 const command=async args=>(await exec(git,['-C',repo,...args],{shell:false,windowsHide:true,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Synthetic fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Synthetic fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}})).stdout.trim();
 await command(['init','--quiet']);await mkdir(join(repo,'src'));await writeFile(join(repo,'src','sample.txt'),'original\n');await writeFile(join(repo,'private.txt'),'not-selected\n');await command(['add','src/sample.txt','private.txt']);await command(['commit','--quiet','-m','synthetic fixture']);const base=await command(['rev-parse','HEAD']);
 const repository={root:repo,allowedPaths:['src'],protectedPaths:['src/private'],baseCommits:[base],operations:['project.inspect','project.propose-patch']};return {repo,state,base,repository,command};
}
test('fixed Git isolated snapshot leaves original dirty checkout unchanged; patch is checked, never applied',async t=>{
 const f=await fixture(t);if(!f)return;await writeFile(join(f.repo,'src','sample.txt'),'dirty local content\n');const manager=await createWorkspaceManager({gitExecutable:git,repository:f.repository,stateRoot:f.state}),workspace=await manager.prepare({workspaceKey:'fixture-one',baseCommit:f.base});assert.equal(await readFile(join(workspace.root,'src','sample.txt'),'utf8'),'original\n');assert.equal(await readFile(join(f.repo,'src','sample.txt'),'utf8'),'dirty local content\n');assert.deepEqual(workspace.files.map(file=>file.path),['src/sample.txt']);assert.equal(await workspace.verify(),true);
 const patch=Buffer.from('diff --git a/src/sample.txt b/src/sample.txt\n--- a/src/sample.txt\n+++ b/src/sample.txt\n@@ -1 +1 @@\n-original\n+proposed\n');const checked=await workspace.checkPatch(patch,4096);assert.equal(checked.applied,false);assert.equal(checked.validatedAgainst,f.base);assert.equal(await readFile(join(workspace.root,'src','sample.txt'),'utf8'),'original\n');assert.equal(await readFile(join(f.repo,'src','sample.txt'),'utf8'),'dirty local content\n');await assert.rejects(manager.prepare({workspaceKey:'fixture-one',baseCommit:f.base}),/already_exists/);
});
test('unregistered commit, tracked attributes and mutated worktree marker are rejected',async t=>{
 const f=await fixture(t);if(!f)return;const manager=await createWorkspaceManager({gitExecutable:git,repository:f.repository,stateRoot:f.state});await assert.rejects(manager.prepare({workspaceKey:'wrong-base',baseCommit:'a'.repeat(40)}),/not_registered/);const workspace=await manager.prepare({workspaceKey:'marker-fixture',baseCommit:f.base});await writeFile(join(workspace.root,'.git'),'gitdir: /foreign\n');await assert.rejects(workspace.verify(),/marker_changed/);
 await writeFile(join(f.repo,'.gitattributes'),'*.txt filter=untrusted\n');await f.command(['add','.gitattributes']);await f.command(['commit','--quiet','-m','synthetic unsupported attributes']);const next=await f.command(['rev-parse','HEAD']),second=await createWorkspaceManager({gitExecutable:git,repository:{...f.repository,baseCommits:[next]},stateRoot:f.state});await assert.rejects(second.prepare({workspaceKey:'attributes-fixture',baseCommit:next}),/attributes_unsupported/);
});
test('narrow patch parser rejects escaping, protected, quoted, binary and executable-mode changes',()=>{
 const repository={allowedPaths:['src'],protectedPaths:['src/private']};
 for(const path of ['../escape','src/private/secret','src/.gitattributes','src/a b.txt','C:escape'])assert.throws(()=>parsePatchPaths(Buffer.from('diff --git a/'+path+' b/'+path+'\n--- a/'+path+'\n+++ b/'+path+'\n'),repository,4096));
 for(const extra of ['new mode 100755','GIT binary patch','rename from src/one'])assert.throws(()=>parsePatchPaths(Buffer.from('diff --git a/src/file b/src/file\n'+extra+'\n'),repository,4096),/unsupported_patch_effect/);
});
test('inspection claims must cite actual allowed exact source hashes and existing lines',()=>{
 const hash='a'.repeat(64),workspace={files:[{path:'src/file',sha256:hash,lineCount:2}]},report={summary:'Synthetic review, not accepted task completion',findings:[{path:'src/file',line:2,claim:'Plain <script> data',evidenceSha256:hash}],limitations:['No model or Windows execution was performed.']};
 assert.equal(validateInspectionReport(report,workspace,4096).contentType,'application/json');assert.throws(()=>validateInspectionReport({...report,findings:[{...report.findings[0],line:3}]},workspace,4096),/source_differs/);assert.throws(()=>validateInspectionReport({...report,findings:[{...report.findings[0],path:'src/foreign'}]},workspace,4096),/source_differs/);assert.throws(()=>validateInspectionReport(report,workspace,8),/output_limit/);
});

/** Portable bounded work-count fixture, not native Windows ACL evidence. */
test('more than256 nested selected files use one fresh tree protection pass and one verification per checkpoint',async t=>{const f=await fixture(t);if(!f)return;for(let group=0;group<3;group++){const dir=join(f.repo,'src','nested-'+group);await mkdir(dir);for(let index=0;index<100;index++)await writeFile(join(dir,'file-'+index+'.txt'),'Synthetic bounded source\n');}await f.command(['add','src']);await f.command(['commit','--quiet','-m','synthetic300filetree']);const base=await f.command(['rev-parse','HEAD']),parent=dirname(f.state),workspaceParent=join(parent,'.control-room-workspaces'),repoRoot=join(workspaceParent,'repo-'+ 'a'.repeat(32));await mkdir(workspaceParent,{mode:0o700});await mkdir(repoRoot,{mode:0o700});const calls=[],manager=await createWorkspaceManager({gitExecutable:git,repository:{...f.repository,baseCommits:[base]},stateRoot:repoRoot,verifyPrivateWorkspace:async(path,options={})=>{calls.push({scope:executorScopeForPath(join(parent,'launch.json'),path),created:options.created===true});}}),workspace=await manager.prepare({workspaceKey:'attempt-'+ 'b'.repeat(32),baseCommit:base});assert.equal(workspace.files.length,301);assert.equal(calls.filter(call=>call.scope==='workspace-tree'&&call.created).length,1);await workspace.verify();await workspace.verify();assert.equal(calls.filter(call=>call.scope==='workspace-tree'&&!call.created).length,2);assert.equal(calls.length,6);});
