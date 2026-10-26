import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryDestination,repositoryBinding} from '../lib/personal-repository-destination.ts';
const reports=[{projectId:'saved-project',report:{repository:{key:'existing'}}}];
const projects=[{id:'saved-project',archivedAt:null},{id:'other',archivedAt:null},{id:'archived',archivedAt:'2026-01-01'}];
test('refresh uses the repository saved project rather than creating duplicate projects',()=>assert.equal(repositoryDestination('existing',{},reports,projects),'saved-project'));
test('durable folder binding wins over reports and navigation context after reload',()=>{
 const mapped=[...projects,{id:'folder-project',archivedAt:null,personalRepositoryKey:'existing'}];
 assert.equal(repositoryDestination('existing',{},reports,mapped,true,'other'),'folder-project');
 assert.equal(repositoryDestination('existing',{existing:'other'},reports,mapped),'folder-project');
 assert.equal(repositoryDestination('existing',{existing:'new'},reports,mapped),'folder-project');
 assert.equal(repositoryDestination('new-folder',{},reports,[...mapped,{id:'old',archivedAt:'2026-01-01',personalRepositoryKey:'new-folder'}]),null);
 assert.equal(repositoryDestination('new-folder',{'new-folder':'other'},reports,[...mapped,{id:'old',archivedAt:'2026-01-01',personalRepositoryKey:'new-folder'}]),null);
 assert.equal(repositoryDestination('new-folder',{'new-folder':'new'},reports,[...mapped,{id:'old',archivedAt:'2026-01-01',personalRepositoryKey:'new-folder'}]),null);
});
test('a new folder defaults to its own new project',()=>assert.equal(repositoryDestination('new-folder',{},reports,projects),'new'));
test('analysis cannot select a destination before saved reports have loaded',()=>assert.equal(repositoryDestination('existing',{},[],projects,false),null));
test('new repository opened from an existing project uses that active project',()=>assert.equal(repositoryDestination('new-folder',{},reports,projects,true,'other'),'other'));
test('saved repository binding wins over project navigation context',()=>assert.equal(repositoryDestination('existing',{},reports,projects,true,'other'),'saved-project'));
test('explicit destination wins over project navigation context',()=>assert.equal(repositoryDestination('new-folder',{'new-folder':'new'},reports,projects,true,'other'),'new'));
test('archived navigation context does not become a destination',()=>assert.equal(repositoryDestination('new-folder',{},reports,projects,true,'archived'),'new'));
test('explicit destination applies only to its repository',()=>{assert.equal(repositoryDestination('existing',{existing:'new'},reports,projects),'new');assert.equal(repositoryDestination('new-folder',{existing:'other'},reports,projects),'new');assert.equal(repositoryDestination('existing',{existing:'other'},reports,projects),'other');});
test('archived or missing saved destinations require a new active project',()=>{assert.equal(repositoryDestination('existing',{},[{projectId:'archived',report:{repository:{key:'existing'}}}],projects),'new');assert.equal(repositoryDestination('existing',{existing:'gone'},reports,projects),'saved-project');});

test('canonical folder lists bind every folder and reserve archived folders',()=>{
 const rows=[{id:'multi',archivedAt:null,personalRepositoryKeys:['app','map']},{id:'old',archivedAt:'2026-01-01',personalRepositoryKeys:['old-map']}];
 assert.equal(repositoryDestination('map',{},[],rows),'multi');
 assert.equal(repositoryDestination('old-map',{'old-map':'multi'},[],rows),null);
});

test('saved analysis destination is not durable ownership',()=>{
 assert.equal(repositoryBinding('existing',projects),null);
 assert.equal(repositoryBinding('map',[{id:'bound',archivedAt:null,personalRepositoryKeys:['app','map']}])?.id,'bound');
});
