import {test,expect,type Page,type Locator} from '@playwright/test';
import {openFixture,workspace,loseNextWorkspaceResponse} from './helpers';

async function registeredFolder(page:Page,count=1){
 const key=`synthetic-folder-${crypto.randomUUID()}`,name=`Synthetic folder ${crypto.randomUUID()}`,actions:Record<string,unknown>[]=[],jobs:Record<string,unknown>[]=[];let online=true;
 const folders=[{key,name,head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false},...Array.from({length:count-1},()=>({key:`synthetic-folder-${crypto.randomUUID()}`,name:`Map lab ${crypto.randomUUID()}`,head:'b'.repeat(40),dirty:false,hasPreviousAnalysis:false}))];
 await page.route('**/api/personal-repositories',async route=>{
  if(route.request().method()==='POST'){const action=route.request().postDataJSON();actions.push(action);if(action.action==='brief')jobs.push({id:action.requestId,kind:'brief',status:'queued',createdAt:new Date().toISOString(),projectId:action.projectId,repositoryKey:action.repositoryKey,provider:action.provider});}
  await route.fulfill({json:{configured:true,deviceId:'synthetic-pc',connected:true,online,lastSeenAt:new Date().toISOString(),providers:{codex:{ready:true,detail:'ready'},claude:{ready:true,detail:'ready'}},repositories:folders,jobs,completedReport:null,completedBriefing:null,policies:[]}});
 });
 return {key,name,actions,folders,goOffline:()=>{online=false;}};
}

async function openRepositories(page:Page){await page.goto('/?view=local-analysis');await page.getByRole('button',{name:'This PC',exact:true}).click();await expect(page.getByRole('heading',{name:'Repositories',exact:true})).toBeVisible();}
function folderCard(page:Page,name:string){return page.locator('[aria-label="Folders on this PC"]').getByRole('article').filter({has:page.getByRole('heading',{name,exact:true})});}
async function createFromFolder(page:Page,name:string){const card=folderCard(page,name);await card.getByRole('button',{name:'Add to project…',exact:true}).click();await card.getByRole('combobox',{name:`Project for ${name}`,exact:true}).selectOption('new');return page.getByRole('dialog',{name:'Create a project from this folder',exact:true});}
async function openTechnical(page:Page){const details=page.locator('details').filter({has:page.locator(':scope > summary').filter({hasText:/^More: technical analysis$/u})});await expect(details).not.toHaveAttribute('open','');await details.locator(':scope > summary').click();await expect(details).toHaveAttribute('open','');return details;}
async function expectVisibleReason(page:Page,control:Locator,reason:RegExp){await expect(control).toHaveAccessibleDescription(reason);const ids=(await control.getAttribute('aria-describedby'))?.split(/\s+/).filter(Boolean)??[];expect(ids.length).toBeGreaterThan(0);for(const id of ids)await expect(page.locator(`[id="${id}"]`)).toBeVisible();}
async function expectVisibleDisabledReason(page:Page,control:Locator,reason:RegExp){await expect(control).toBeDisabled();await expectVisibleReason(page,control,reason);}
async function openHome(page:Page){await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Home',exact:true}).click();await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();}

test('project framing and optional task plan persist through editor save and reload',async({page})=>{
 await openFixture(page);await page.getByRole('button',{name:'Projects',exact:true}).click();await page.getByRole('button',{name:'New project',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Create project',exact:true}),name=`Synthetic framed project ${crypto.randomUUID()}`;
 await expect(dialog.getByLabel('What this project is and why',{exact:true})).toHaveValue('');await expect(dialog.getByRole('checkbox',{name:'Include my task plan in briefings',exact:true})).not.toBeChecked();
 await expect(dialog.getByLabel('What this project is and why',{exact:true})).toHaveAttribute('maxlength','2500');await dialog.getByLabel('Project name',{exact:true}).fill(name);
 await dialog.getByLabel('What this project is and why',{exact:true}).fill('Explain how this synthetic project helps its intended users.');await dialog.getByRole('checkbox',{name:'Include my task plan in briefings',exact:true}).check();await dialog.getByRole('button',{name:'Create project',exact:true}).click();await expect(dialog).not.toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{name:string})=>row.name===name);expect(project.framing).toBe('Explain how this synthetic project helps its intended users.');expect(project.includeTaskPlanInBriefings).toBe(true);
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);await page.getByRole('button',{name:'Edit project',exact:true}).click();const edit=page.getByRole('dialog',{name:'Edit project',exact:true});await expect(edit.getByLabel('What this project is and why',{exact:true})).toHaveValue(project.framing);await expect(edit.getByRole('checkbox',{name:'Include my task plan in briefings',exact:true})).toBeChecked();
});

test('folder creates and maps a blank project without running AI; the Home briefing needs an explicit click after reload',async({page})=>{
 const folder=await registeredFolder(page);await openFixture(page);await openRepositories(page);
 const create=await createFromFolder(page,folder.name);await create.getByRole('button',{name:'Create project',exact:true}).click();
 await expect(folderCard(page,folder.name).getByRole('link',{name:folder.name,exact:true})).toBeVisible();expect(folder.actions).toEqual([]);
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key));expect(project).toBeTruthy();expect(project.name).toBe(folder.name);expect(project.framing).toBe('');expect(project.includeTaskPlanInBriefings).toBe(false);
 await page.reload();await expect(folderCard(page,folder.name).getByRole('button',{name:'Add to project…',exact:true})).toHaveCount(0);await expect(folderCard(page,folder.name).getByRole('link',{name:project.name,exact:true})).toHaveAttribute('href',`/?view=projects&entity=project&id=${project.id}`);expect(folder.actions).toEqual([]);
 await openHome(page);const card=page.getByRole('article',{name:project.name,exact:true}),brief=card.getByRole('button',{name:'Brief this project',exact:true});await expect(brief).toBeEnabled();await page.waitForTimeout(1000);expect(folder.actions).toEqual([]);await brief.click();await expect.poll(()=>folder.actions.length).toBe(1);expect(folder.actions[0]).toMatchObject({action:'brief',repositoryKey:folder.key,projectId:project.id,provider:'codex'});
 await expect(card.getByRole('status').filter({hasText:'Waiting for your PC to start the briefing…'})).toBeVisible();await expectVisibleDisabledReason(page,brief,/A briefing is already running for this project\./);expect(folder.actions).toHaveLength(1);
});

test('the project page briefing comes first and uses the assistant chosen in its settings, only on an explicit click',async({page})=>{
 const folder=await registeredFolder(page);await openFixture(page);await openRepositories(page);
 const create=await createFromFolder(page,folder.name);await create.getByRole('button',{name:'Create project',exact:true}).click();await expect(folderCard(page,folder.name).getByRole('link',{name:folder.name,exact:true})).toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key));
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);const briefing=page.getByRole('region',{name:'Briefing',exact:true}),folders=page.getByRole('region',{name:'Project folders',exact:true});
 await expect(briefing).toBeVisible();await expect(folders).toBeVisible();
 // Briefing first, then folders, then the folded plan, then the project details.
 const order=await page.evaluate(()=>['.project-briefing','#project-folders','details.project-fold','.project-about'].map(selector=>document.querySelector(selector)?.getBoundingClientRect().top??-1));
 expect(order.every(value=>value>=0)).toBe(true);expect(order).toEqual([...order].sort((a,b)=>a-b));
 await expect(page.locator('details.project-fold')).not.toHaveAttribute('open','');await expect(page.getByRole('button',{name:'Add milestone',exact:true})).toHaveCount(0);
 const brief=briefing.getByRole('button',{name:'Brief this project',exact:true});await expect(brief).toBeEnabled();await page.waitForTimeout(1000);expect(folder.actions).toEqual([]);
 await briefing.locator('details').filter({has:page.locator(':scope > summary').filter({hasText:/^Briefing settings$/u})}).locator(':scope > summary').click();
 await briefing.getByRole('combobox',{name:'Assistant',exact:true}).selectOption('claude');expect(folder.actions).toEqual([]);
 await brief.click();await expect.poll(()=>folder.actions.length).toBe(1);expect(folder.actions[0]).toMatchObject({action:'brief',repositoryKey:folder.key,projectId:project.id,provider:'claude'});
 await expect(briefing.getByRole('status').filter({hasText:'Waiting for your PC to start the briefing…'})).toBeVisible();await expectVisibleDisabledReason(page,brief,/A briefing is already running for this project\./);expect(folder.actions).toHaveLength(1);
});

test('an uncertain project save prevents duplicate creation until its original outcome is checked',async({page})=>{
 const folder=await registeredFolder(page);await openFixture(page);await openRepositories(page);
 await page.route('**/api/workspace/mutations/*',route=>route.abort('failed'));const lost=await loseNextWorkspaceResponse(page);
 const create=await createFromFolder(page,folder.name);await create.getByRole('button',{name:'Create project',exact:true}).click();
 await expect(page.getByRole('button',{name:'Check original save',exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Create a project from this folder',exact:true})).not.toBeVisible();expect(lost.lost()).toBe(true);expect(folder.actions).toEqual([]);
 expect((await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key))).toHaveLength(1);
 await page.unroute('**/api/workspace/mutations/*');await page.getByRole('button',{name:'Check original save',exact:true}).click();
 await expect(folderCard(page,folder.name).getByRole('link',{name:folder.name,exact:true})).toBeVisible();expect(folder.actions).toEqual([]);
 expect((await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key))).toHaveLength(1);
});

test('an archived folder association asks for project restoration and cannot create or run another request',async({page})=>{
 const folder=await registeredFolder(page);await openFixture(page);await openRepositories(page);
 const create=await createFromFolder(page,folder.name);await create.getByRole('button',{name:'Create project',exact:true}).click();await expect(folderCard(page,folder.name).getByRole('link',{name:folder.name,exact:true})).toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key));
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);await page.getByRole('button',{name:'Archive project',exact:true}).click();await expect(page.getByRole('heading',{name:'This project is archived',exact:true})).toBeVisible();
 await openRepositories(page);await expect(folderCard(page,folder.name).getByText(`In archived project ${folder.name}. Restore it from Projects.`,{exact:true})).toBeVisible();
 await expect(folderCard(page,folder.name).getByRole('button',{name:'Add to project…',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Brief this project',exact:true})).toHaveCount(0);await openTechnical(page);await expect(page.getByRole('button',{name:'Analyze',exact:true})).toBeDisabled();await expect(page.getByRole('combobox',{name:'Save to project',exact:true})).toBeDisabled();expect(folder.actions).toEqual([]);
});

test('two PC folders join one framed project and remain listed after reload without inference',async({page},testInfo)=>{
 const registered=await registeredFolder(page,2),[app,lab]=registered.folders;await openFixture(page);await openRepositories(page);
 const dialog=await createFromFolder(page,app.name);
 await expect(dialog.getByLabel('What this project is and why',{exact:true})).toBeFocused();await dialog.getByLabel('What this project is and why',{exact:true}).fill('The app and its map lab deliver one clear map experience.');await dialog.getByRole('button',{name:'Create project',exact:true}).click();await expect(dialog).not.toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(app.key));expect(project.framing).toContain('map lab');
 const labCard=folderCard(page,lab.name);await labCard.getByRole('button',{name:'Add to project…',exact:true}).click();await labCard.getByRole('combobox',{name:`Project for ${lab.name}`,exact:true}).selectOption(project.id);await labCard.getByRole('button',{name:'Add folder to project',exact:true}).click();
 await expect.poll(async()=>(await workspace(page)).workspace.projects.find((row:{id:string})=>row.id===project.id).personalRepositoryKeys).toEqual([app.key,lab.key]);
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);await page.reload();const folderList=page.getByRole('region',{name:'Project folders',exact:true});await expect(folderList.getByRole('listitem').filter({hasText:app.name})).toBeVisible();await expect(folderList.getByRole('listitem').filter({hasText:lab.name})).toBeVisible();await expect(folderList.getByRole('button',{name:'Add a folder from this PC',exact:true})).toBeEnabled();expect(registered.actions).toEqual([]);
 await page.screenshot({path:testInfo.outputPath('multi-folder-project-synthetic.png'),fullPage:true});
});

test('project folder chooser adds, removes and re-adds an existing folder without inference or duplicate ownership',async({page})=>{
 const registered=await registeredFolder(page),folder=registered.folders[0];await openFixture(page);
 const name=`Synthetic folder owner ${crypto.randomUUID()}`;await page.getByRole('button',{name:'Projects',exact:true}).click();await page.getByRole('button',{name:'New project',exact:true}).click();const create=page.getByRole('dialog',{name:'Create project',exact:true});await create.getByLabel('Project name',{exact:true}).fill(name);await create.getByRole('button',{name:'Create project',exact:true}).click();await expect(create).not.toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{name:string})=>row.name===name);
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);const list=page.getByRole('region',{name:'Project folders',exact:true});
 await list.getByRole('button',{name:'Add a folder from this PC',exact:true}).click();const choice=page.getByRole('combobox',{name:'Folder to add',exact:true});await expect(choice.getByRole('option',{name:folder.name,exact:true})).toHaveCount(1);await choice.selectOption(folder.key);
 await expect(list.getByRole('listitem').filter({hasText:folder.name})).toBeVisible();expect(registered.actions).toEqual([]);
 await list.getByRole('button',{name:`Remove ${folder.name} from project`,exact:true}).click();await expect(list.getByRole('listitem').filter({hasText:folder.name})).toHaveCount(0);
 await expect.poll(async()=>(await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key))).toHaveLength(0);
 await openRepositories(page);const card=folderCard(page,folder.name);await expect(card.getByText('Not in a project',{exact:true})).toBeVisible();await card.getByRole('button',{name:'Add to project…',exact:true}).click();await card.getByRole('combobox',{name:`Project for ${folder.name}`,exact:true}).selectOption(project.id);await card.getByRole('button',{name:'Add folder to project',exact:true}).click();
 await expect(card.getByRole('link',{name:project.name,exact:true})).toBeVisible();expect(registered.actions).toEqual([]);
 const owners=(await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key));expect(owners).toHaveLength(1);expect(owners[0].id).toBe(project.id);expect(owners[0].personalRepositoryKeys.filter((key:string)=>key===folder.key)).toHaveLength(1);
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);await page.reload();await expect(page.getByRole('region',{name:'Project folders',exact:true}).getByRole('listitem').filter({hasText:folder.name})).toBeVisible();expect(registered.actions).toEqual([]);
});

test('offline folder actions and Home and project briefings explain disabled controls visibly and accessibly',async({page})=>{
 const registered=await registeredFolder(page);await openFixture(page);await openRepositories(page);const create=await createFromFolder(page,registered.name);await create.getByRole('button',{name:'Create project',exact:true}).click();await expect(folderCard(page,registered.name).getByRole('link',{name:registered.name,exact:true})).toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(registered.key));registered.goOffline();
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);const list=page.getByRole('region',{name:'Project folders',exact:true});await list.getByRole('button',{name:'Add a folder from this PC',exact:true}).click();const chooser=page.getByRole('combobox',{name:'Folder to add',exact:true});await expect(chooser.locator('option[value="__browse__"]')).toHaveJSProperty('disabled',true);await expectVisibleReason(page,chooser,/PC is offline/);await expectVisibleDisabledReason(page,list.getByRole('button',{name:'Brief this project',exact:true}),/PC is offline/);await expectVisibleDisabledReason(page,page.getByRole('region',{name:'Briefing',exact:true}).getByRole('button',{name:'Brief this project',exact:true}),/PC is offline/);
 await openRepositories(page);await expectVisibleDisabledReason(page,page.getByRole('button',{name:'Add a folder from this PC',exact:true}),/PC is offline/);await openTechnical(page);await expectVisibleDisabledReason(page,page.getByRole('button',{name:'Analyze',exact:true}),/PC is offline/);
 await openHome(page);const card=page.getByRole('article',{name:project.name,exact:true});await expectVisibleDisabledReason(page,card.getByRole('button',{name:'Brief this project',exact:true}),/PC is offline/);expect(registered.actions).toEqual([]);
});

test('a folder registered by an overlapping PC picker requires one explicit Add folder click',async({page})=>{
 // Our PC picker chose existing Y; the other window registered X. The feed has
 // no per-request selected key, so neither folder may be attached by inference.
 const existing={key:`synthetic-y-${crypto.randomUUID()}`,name:'Synthetic existing Y',head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false},candidate={...existing,key:`synthetic-x-${crypto.randomUUID()}`,name:'Synthetic overlapping X'},actions:Record<string,unknown>[]=[];
 let otherStarted=false,requestId:string|null=null,saves=0;
 await page.route('**/api/personal-repositories',async route=>{
  if(route.request().method()==='POST'){const action=route.request().postDataJSON();actions.push(action);if(action.action==='browse')requestId=action.requestId;}
  const createdAt=new Date().toISOString(),jobs=requestId?[{id:'synthetic-other-picker',kind:'browse',status:'completed',createdAt},{id:requestId,kind:'browse',status:'completed',createdAt}]:otherStarted?[{id:'synthetic-other-picker',kind:'browse',status:'claimed',createdAt}]:[];
  await route.fulfill({json:{configured:true,deviceId:'synthetic-pc',connected:true,online:true,lastSeenAt:createdAt,providers:{codex:{ready:true,detail:'ready'},claude:{ready:true,detail:'ready'}},repositories:requestId?[existing,candidate]:[existing],jobs,completedReport:null,completedBriefing:null,policies:[]}});
 });
 await openFixture(page);await page.getByRole('button',{name:'Projects',exact:true}).click();await page.getByRole('button',{name:'New project',exact:true}).click();
 const name=`Synthetic picker confirmation ${crypto.randomUUID()}`,create=page.getByRole('dialog',{name:'Create project',exact:true});await create.getByLabel('Project name',{exact:true}).fill(name);await create.getByRole('button',{name:'Create project',exact:true}).click();await expect(create).not.toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{name:string})=>row.name===name);
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);const list=page.getByRole('region',{name:'Project folders',exact:true});await list.getByRole('button',{name:'Add a folder from this PC',exact:true}).click();
 const chooser=list.getByRole('combobox',{name:'Folder to add',exact:true});await expect(chooser.locator('option[value="__browse__"]')).toHaveJSProperty('disabled',false);
 await page.route('**/api/workspace',async route=>{if(route.request().method()==='POST')saves++;await route.continue();});
 otherStarted=true;await chooser.selectOption('__browse__');
 await expect(list.getByRole('status').filter({hasText:'Your PC added a folder'})).toHaveText('Your PC added a folder while another folder window was open. Check the folder below and add it.');await expect(chooser).toHaveValue(candidate.key);
 const add=list.getByRole('button',{name:'Add folder',exact:true});await expect(add).toBeEnabled();await chooser.selectOption(existing.key);await expect(chooser).toHaveValue(existing.key);await chooser.selectOption(candidate.key);await expect(chooser).toHaveValue(candidate.key);expect(saves).toBe(0);expect(actions).toEqual([{action:'browse',requestId:expect.any(String)}]);
 const before=(await workspace(page)).workspace.projects;expect(before.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(candidate.key)||row.personalRepositoryKeys?.includes(existing.key))).toHaveLength(0);
 await add.click();await expect(list.getByRole('listitem').filter({hasText:candidate.name})).toHaveCount(1);await expect(add).toHaveCount(0);expect(saves).toBe(1);
 const owners=(await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(candidate.key));expect(owners).toHaveLength(1);expect(owners[0].id).toBe(project.id);expect(owners[0].personalRepositoryKeys).toEqual([candidate.key]);expect(actions).toEqual([{action:'browse',requestId:expect.any(String)}]);
 await page.reload();await expect(page.getByRole('region',{name:'Project folders',exact:true}).getByRole('listitem').filter({hasText:candidate.name})).toHaveCount(1);expect(saves).toBe(1);
});

test('saved technical reports stay lazy and an unresolved read does not block folder ownership',async({page})=>{
 const registered=await registeredFolder(page);let reads=0,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/local-analysis',async route=>{reads++;await held;await route.continue();});
 try{
  await openFixture(page);await openRepositories(page);const card=folderCard(page,registered.name),browse=page.getByRole('button',{name:'Add a folder from this PC',exact:true});
  await expect(browse).toBeEnabled();await expect(card.getByRole('button',{name:'Add to project…',exact:true})).toBeEnabled();expect(reads).toBe(0);
  await openTechnical(page);await expect.poll(()=>reads).toBe(1);await expect(page.getByRole('status').filter({hasText:'Loading saved reports'})).toBeVisible();
  await expect(browse).toBeEnabled();await expect(card.getByRole('button',{name:'Add to project…',exact:true})).toBeEnabled();await card.getByRole('button',{name:'Add to project…',exact:true}).click();
  const project=(await workspace(page)).workspace.projects.find((row:{id:string})=>row.id==='synthetic-project');await card.getByRole('combobox',{name:`Project for ${registered.name}`,exact:true}).selectOption(project.id);await card.getByRole('button',{name:'Add folder to project',exact:true}).click();
  await expect(card.getByRole('link',{name:project.name,exact:true})).toBeVisible();await expect(browse).toBeEnabled();await expect(page.getByRole('status').filter({hasText:'Loading saved reports'})).toBeVisible();expect(registered.actions).toEqual([]);
  const owners=(await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(registered.key));expect(owners).toHaveLength(1);expect(owners[0].id).toBe(project.id);
 }finally{release();}
});
