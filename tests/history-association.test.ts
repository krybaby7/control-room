import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveAssociation,associationTarget,canonicalRepositoryIdentity} from '../lib/history/association.ts';
import {workspace,body,claim} from './fixtures/history-understanding.ts';
import type {AssociationRule} from '../lib/history/contracts.ts';
const rule=(id:string,areaId:string|null,scope:AssociationRule['scope'],targetIds:string[],projectId='project'):AssociationRule=>({id,projectId,areaId,scope,targetIds,reason:'Synthetic owner mapping',provenanceRef:'owner-command:'+id,rowRevision:1});
test('verified exact repositories map product areas without basename or title inference',async()=>{
 const context=claim(await body('message','source text')).context;
 const app=rule('app','app','repository',[associationTarget('source','https://github.com/Example/App.git')]),map=rule('map','map','repository',[associationTarget('source','github.com/example/map-lab')]);
 const run=(repositoryIdentity:string)=>resolveAssociation({workspace,context:{...context,repositoryIdentity},ownerRules:[],verifiedRepositoryRules:[app,map],trustVerifiedRepositoryRule:()=>true});
 assert.equal(run('git@github.com:EXAMPLE/APP.git').areaId,'app');assert.equal(run('github.com/example/map-lab').areaId,'map');assert.equal(run('github.com/other/app').status,'unresolved');
 assert.equal(canonicalRepositoryIdentity('https://user:password@github.com/example/app'),null);
 assert.equal(canonicalRepositoryIdentity('https://gitlab.example/Owner/App'),'gitlab.example/Owner/App');
});
test('source-qualified message overrides win; conflicting rules stay ambiguous and untrusted suggestions cannot assign',async()=>{
 const context=claim(await body('same-native','source text')).context;
 const global=rule('repo','app','repository',[associationTarget('source','github.com/example/app')]),override=rule('message','map','messages',[associationTarget('source','same-native')]);
 const input={workspace,context,ownerRules:[global,override],trustRule:()=>true};assert.equal(resolveAssociation(input).areaId,'map');
 assert.equal(resolveAssociation({...input,context:{...context,sourceId:'other-provider'}}).status,'unresolved');
 assert.equal(resolveAssociation({...input,ownerRules:[override,rule('conflict','other-area','messages',[associationTarget('source','same-native')],'other-project')]}).status,'ambiguous');
 assert.equal(resolveAssociation({...input,ownerRules:[],suggestions:[{projectId:'project',areaId:'app',citationRef:'quote'}]}).status,'unresolved');
 assert.equal(resolveAssociation({...input,trustRule:()=>false}).status,'unresolved');
 assert.equal(resolveAssociation({...input,ownerRules:[rule('unclassified',null,'conversation',[associationTarget('source',context.conversationId)])]}).status,'unclassified');
});
test('imported provenance never authorizes owner overrides or legacy unqualified repository rules',async()=>{
 const context=claim(await body('message','source text')).context;
 const imported=rule('imported','app','repository',[associationTarget('source','github.com/example/app')]);
 assert.equal(resolveAssociation({workspace,context,ownerRules:[{...imported,provenanceRef:'owner-mutation:forged'}]}).status,'unresolved');
 assert.equal(resolveAssociation({workspace,context,ownerRules:[{...imported,targetIds:['github.com/example/app']}],trustRule:()=>true}).status,'unresolved');
 assert.equal(resolveAssociation({workspace,context,ownerRules:[],verifiedRepositoryRules:[imported],trustRule:()=>true}).status,'unresolved');
 assert.equal(resolveAssociation({workspace,context,ownerRules:[imported],trustVerifiedRepositoryRule:()=>true}).status,'unresolved');
 assert.equal(resolveAssociation({workspace,context,ownerRules:[],verifiedRepositoryRules:[imported],trustVerifiedRepositoryRule:()=>true}).areaId,'app');
});
