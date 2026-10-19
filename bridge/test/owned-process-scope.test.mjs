import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWindowsExecutorDirectoryScope as scope} from '../executor/owned-process.mjs';
test('executor scope bounds derive from selected directory purpose and reject cross-root paths',()=>{
 const state='C:\\synthetic\\.control-room-executor',workspaces='C:\\synthetic\\.control-room-workspaces',repo=workspaces+'\\repo-'+ 'a'.repeat(32),attempt=repo+'\\worktrees\\attempt-'+ 'b'.repeat(32);
 for(const [path,name,cap]of [[state,'state-root',6],[state+'\\attempts','attempts',14],[state+'\\attempts\\'+ 'c'.repeat(64),'attempt',8],[state+'\\attempts\\'+ 'c'.repeat(64)+'\\artifacts','artifacts',101],[state+'\\runtime','runtime',5],[state+'\\runtime\\src','runtime-src',5],[state+'\\claims','claims',14],[state+'\\reservations','reservations',13],[workspaces,'workspace-root',33],[repo,'workspace-repository',16],[repo+'\\worktrees','workspace-attempts',13],[repo+'\\empty-hooks','workspace-empty',1],[attempt,'workspace-tree',512002]])assert.equal(scope(path,name),cap);
 for(const [path,name]of [[attempt,'state-root'],[state,'workspace-tree'],[attempt+'\\nested','workspace-tree'],['C:\\foreign','state-root'],[state+'\\..\\foreign','state-root'],[workspaces+'\\arbitrary','workspace-repository'],[repo+'\\worktrees\\attempt-invalid','workspace-tree']])assert.throws(()=>scope(path,name),/invalid_executor_directory_scope/);
});
