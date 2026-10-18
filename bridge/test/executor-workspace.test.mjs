import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
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
