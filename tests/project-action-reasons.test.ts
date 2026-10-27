import test from 'node:test';
import assert from 'node:assert/strict';
import {availableProjectFolders,firstDisabledReason,projectActionDisabledReason as reason} from '../lib/project-action-reasons.ts';

test('folder actions only consider conditions relevant to the owner command',()=>{
 assert.equal(reason('remove-folder',{online:false,assistantReady:false,folderCount:4,briefingRunning:true}),null);
 assert.equal(reason('add-folder',{online:false,assistantReady:false,briefingRunning:true,folderSelected:true}),null);
 assert.equal(reason('navigate-folders',{archived:true,saving:true,folderCount:4,online:false}),null);
 assert.match(reason('remove-folder',{saving:true})!,/saving/i);
 assert.match(reason('add-folder',{folderCount:4})!,/four folders/i);
 assert.match(reason('add-folder',{folderSelected:false})!,/choose a folder/i);
 assert.match(reason('choose-folder',{online:false})!,/PC.*offline/i);
 assert.match(reason('brief',{folderCount:0})!,/add a folder/i);
 assert.match(reason('brief',{assistantReady:false})!,/sign in/i);
 assert.match(reason('brief',{briefingRunning:true})!,/briefing.*running/i);
 assert.match(reason('brief',{choosingFolder:true})!,/choosing a folder/i);
 assert.match(reason('brief',{archived:true,saving:true})!,/restore/i);
});
test('all surfaces share exact reasons and the first applicable reason wins',()=>{
 assert.equal(reason('brief',{archived:true,saving:true,online:false}),'Restore this project to change its folders.');
 assert.equal(reason('brief',{saving:true,online:false}),'Saving… wait a moment.');
 assert.equal(reason('add-folder',{folderCount:4,folderSelected:false}),'A project can have up to four folders.');
 assert.equal(reason('brief',{online:false,assistantReady:false}),'Your PC is offline. Open the Control Room PC app on your PC.');
 assert.equal(reason('brief',{online:true,choosingFolder:true,assistantReady:false}),'Your PC is choosing a folder. Finish or cancel the folder window on your PC.');
 assert.equal(reason('brief',{folderCount:0}),'Add a folder first.');
 assert.equal(reason('brief',{briefingRunning:true}),'A briefing is already running for this project.');
 assert.equal(reason('brief',{assistant:'claude',assistantReady:false}),'Claude Code isn’t ready on your PC. Open Claude Code on your PC and sign in.');
});
test('first reason is deterministic and excludes empty conditions',()=>{assert.equal(firstDisabledReason(false,null,undefined,'Wait for saving.','Offline.'),'Wait for saving.');assert.equal(firstDisabledReason(false,null),null);});
test('available folders exclude every active and archived owner',()=>{
 const rows=[{key:'app',name:'App'},{key:'lab',name:'Lab'},{key:'free',name:'Free'}];
 assert.deepEqual(availableProjectFolders(rows,[{personalRepositoryKeys:['app']},{personalRepositoryKeys:['lab']}]),[rows[2]]);
});

test('last poll controls PC app compatibility including a later legacy poll',async()=>{
 const {personalCompanionStatus,personalJobFailureReason}=await import('../lib/project-action-reasons.ts');
 const current={protocol:1,kinds:['brief'],legacy:false,release:'27',lastSeenAt:'2026-10-27T12:00:00Z'};
 assert.equal(personalCompanionStatus(current).label,'PC app: current');
 assert.match(personalCompanionStatus(current).detail,/27/);
 assert.equal(personalCompanionStatus({...current,legacy:true,protocol:null}).label,'PC app: out of date — update it');
 assert.equal(personalCompanionStatus({...current,kinds:['browse']}).state,'outdated');
 assert.equal(personalCompanionStatus(null).state,'unknown');
 assert.equal(personalJobFailureReason('companion_outdated','brief'),"Your Control Room PC app is out of date, so it couldn't run this briefing. Close the old PC app; if it keeps happening, update the PC app.");
 assert.equal(personalJobFailureReason('unsupported','brief'),personalJobFailureReason('companion_outdated','brief'));
 assert.equal(personalJobFailureReason('deadline_exceeded','brief'),null);
});

test('outdated PC app failures explain folder selection and analysis recovery',async()=>{
 const {personalJobFailureReason}=await import('../lib/project-action-reasons.ts');
 for(const error of ['companion_outdated','unsupported'])for(const [kind,action] of [['browse',"choose a folder"],['analyze',"analyze this folder"],['other',"run this request"]]){
  assert.equal(personalJobFailureReason(error,kind),`Your Control Room PC app is out of date, so it couldn't ${action}. Close the old PC app; if it keeps happening, update the PC app.`);
 }
});
