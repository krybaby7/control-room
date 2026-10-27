import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseProjectFolder,projectFolderEditCommand} from '../lib/project-folder-picker.ts';
const job=(status:string)=>({id:'request',kind:'browse',status});
test('another browse completing with X cannot auto-attach X when this picker chose existing Y',async()=>{
 const f=fixture();let reads=0;
 const result=await chooseProjectFolder({...f.options,read:async()=>++reads===1
  ?{repositories:[{key:'old',name:'old'},{key:'Y',name:'Y'}],jobs:[{id:'other-window',kind:'browse',status:'claimed'}]}
  :{repositories:[{key:'old',name:'old'},{key:'Y',name:'Y'},{key:'X',name:'X'}],jobs:[job('completed'),{id:'other-window',kind:'browse',status:'completed'}]}});
 assert.deepEqual(f.saved,[]);
 assert.deepEqual(result,{status:'confirmation-required',folderKey:'X'});
});
function fixture(status='completed',added=['new']){
 const sent:unknown[]=[],saved:string[][]=[];let reads=0;
 const options={projectId:'p',requestId:'request',signal:new AbortController().signal,read:async()=>({repositories:(reads++?['old',...added]:['old']).map(key=>({key,name:key})),jobs:reads>1?[job(status)]:[]}),send:async(action:unknown)=>{sent.push(action);},current:()=>({project:{id:'p',personalRepositoryKeys:['old']},projects:[{personalRepositoryKeys:['old']}]}),save:async(keys:string[])=>{saved.push(keys);},wait:async()=>{}};
 return {sent,saved,options};
}
test('picker sends only the browse identity and appends exactly one new folder',async()=>{const f=fixture();assert.equal(await chooseProjectFolder(f.options),'added');assert.deepEqual(f.sent,[{action:'browse',requestId:'request'}]);assert.deepEqual(f.saved,[['old','new']]);});
test('other active browse jobs in the before read require confirmation even without a later status change',async()=>{
 for(const status of ['queued','claimed']){
  const f=fixture();let reads=0;
  const result=await chooseProjectFolder({...f.options,read:async()=>({repositories:(reads++?['old','new']:['old']).map(key=>({key,name:key})),jobs:[{id:'other',kind:'browse',status},...(reads>1?[job('completed')]:[])]})});
  assert.deepEqual(result,{status:'confirmation-required',folderKey:'new'});assert.deepEqual(f.saved,[]);
 }
});
test('other browse additions and status changes through every poll make confirmation sticky',async()=>{
 for(const history of [
  [[],[{id:'other',kind:'browse',status:'completed'}]],
  [[],[{id:'other',kind:'browse',status:'queued'}],[]],
  [[{id:'other',kind:'browse',status:'cancelled'}],[{id:'other',kind:'browse',status:'completed'}],[{id:'other',kind:'browse',status:'cancelled'}]],
 ]){
  const f=fixture();let reads=0;
  const result=await chooseProjectFolder({...f.options,read:async()=>{const index=reads++;return {repositories:(index?['old','new']:['old']).map(key=>({key,name:key})),jobs:[...history[index],...(index?[job(index===history.length-1?'completed':'claimed')]:[])]};}});
  assert.deepEqual(result,{status:'confirmation-required',folderKey:'new'});assert.deepEqual(f.saved,[]);assert.equal(reads,history.length);
 }
});
test('unchanged terminal browse history and changing non-browse work do not block clean automatic addition',async()=>{
 const f=fixture();let reads=0;
 const result=await chooseProjectFolder({...f.options,read:async()=>{const index=reads++;return {repositories:(index?['old','new']:['old']).map(key=>({key,name:key})),jobs:[{id:'old-window',kind:'browse',status:'completed'},...(index?[job(index===2?'completed':'claimed'),{id:'analysis',kind:'analyze',status:index===2?'completed':'claimed'}]:[])]};}});
 assert.equal(result,'added');assert.deepEqual(f.saved,[['old','new']]);assert.equal(reads,3);
});
test('picker never guesses when existing, cancelled, ambiguous, or incomplete',async()=>{
 for(const [status,added,result] of [['completed',[],'existing'],['cancelled',[],'cancelled']] as const){const f=fixture(status,[...added]);assert.equal(await chooseProjectFolder(f.options),result);assert.deepEqual(f.saved,[]);}
 const ambiguous=fixture('completed',['a','b']);await assert.rejects(chooseProjectFolder(ambiguous.options),/More than one/);assert.deepEqual(ambiguous.saved,[]);
 const pending=fixture('queued');assert.equal(await chooseProjectFolder({...pending.options,attempts:2}),'pending');assert.deepEqual(pending.saved,[]);
});
test('dirty windows preserve existing, cancellation, ambiguous, pending and recovered outcomes',async()=>{
 for(const [status,added,expected] of [['completed',[],'existing'],['cancelled',['new'],'cancelled'],['queued',['new'],'pending']] as const){
  const f=fixture(status,[...added]),read=f.options.read;
  assert.equal(await chooseProjectFolder({...f.options,attempts:2,read:async()=>{const value=await read();return {...value,jobs:[...value.jobs,{id:'other',kind:'browse',status:'claimed'}]};}}),expected);assert.deepEqual(f.saved,[]);
 }
 for(const [added,retry,expected] of [[['a','b'],false,'ambiguous'],[['new'],true,'review']] as const){
  const f=fixture('completed',[...added]),read=f.options.read;
  const outcome=chooseProjectFolder({...f.options,retry,read:async()=>{const value=await read();return {...value,jobs:[...value.jobs,{id:'other',kind:'browse',status:'claimed'}]};}});
  if(expected==='ambiguous')await assert.rejects(outcome,/More than one/);else assert.equal(await outcome,expected);
  assert.deepEqual(f.saved,[]);
 }
});
test('picker rechecks current archived, full, changed and other ownership before saving',async()=>{
 for(const current of [()=>({project:{id:'p',archivedAt:'now',personalRepositoryKeys:['old']},projects:[]}),()=>({project:{id:'p',personalRepositoryKeys:['1','2','3','4']},projects:[]}),()=>({project:{id:'different',personalRepositoryKeys:[]},projects:[]}),()=>({project:{id:'p',personalRepositoryKeys:['old']},projects:[{personalRepositoryKeys:['new']}]})]){const f=fixture();await assert.rejects(chooseProjectFolder({...f.options,current}));assert.deepEqual(f.saved,[]);}
});
test('aborting a picker prevents enqueue or later workspace changes',async()=>{
 const before=fixture(),abort=new AbortController();abort.abort();await assert.rejects(chooseProjectFolder({...before.options,signal:abort.signal}));assert.deepEqual(before.sent,[]);
 const during=fixture(),controller=new AbortController();await assert.rejects(chooseProjectFolder({...during.options,signal:controller.signal,send:async()=>{controller.abort();}}));assert.deepEqual(during.saved,[]);
});
test('recovered request keeps its identity and requires explicit attachment after completion',async()=>{const f=fixture();assert.equal(await chooseProjectFolder({...f.options,retry:true}),'review');assert.deepEqual(f.sent,[{action:'browse',requestId:'request'}]);assert.deepEqual(f.saved,[]);});
test('folder edits use the authoritative project edit path and preserve the remaining order',()=>{
 assert.deepEqual(projectFolderEditCommand('p',['app','lab']),{type:'project.edit',id:'p',patch:{personalRepositoryKeys:['app','lab']}});
 assert.deepEqual(projectFolderEditCommand('p',['app','lab'].filter(key=>key!=='app')),{type:'project.edit',id:'p',patch:{personalRepositoryKeys:['lab']}});
});
test('unconfirmed workspace save rejects the picker outcome without claiming success',async()=>{const f=fixture();await assert.rejects(chooseProjectFolder({...f.options,save:async()=>{throw new Error('The save is still unconfirmed.');}}),/still unconfirmed/);});
test('the total picker deadline bounds a read that has not completed',async()=>{const f=fixture();assert.equal(await chooseProjectFolder({...f.options,deadlineMs:5,read:signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}),'pending');assert.deepEqual(f.sent,[]);});
