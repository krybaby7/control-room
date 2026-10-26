import {test,expect,type Page} from '@playwright/test';
import {openFixture,workspace,loseNextWorkspaceResponse} from './helpers';

async function registeredFolder(page:Page,count=1){
 const key=`synthetic-folder-${crypto.randomUUID()}`,name=`Synthetic folder ${crypto.randomUUID()}`,actions:Record<string,unknown>[]=[],jobs:Record<string,unknown>[]=[];
 const folders=[{key,name,head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false},...Array.from({length:count-1},()=>({key:`synthetic-folder-${crypto.randomUUID()}`,name:`Map lab ${crypto.randomUUID()}`,head:'b'.repeat(40),dirty:false,hasPreviousAnalysis:false}))];
 await page.route('**/api/personal-repositories',async route=>{
  if(route.request().method()==='POST'){const action=route.request().postDataJSON();actions.push(action);if(action.action==='brief')jobs.push({id:action.requestId,kind:'brief',status:'queued',createdAt:new Date().toISOString(),projectId:action.projectId,repositoryKey:action.repositoryKey,provider:action.provider});}
  await route.fulfill({json:{configured:true,deviceId:'synthetic-pc',connected:true,online:true,lastSeenAt:new Date().toISOString(),providers:{codex:{ready:true,detail:'ready'},claude:{ready:true,detail:'ready'}},repositories:folders,jobs,completedReport:null,completedBriefing:null,policies:[]}});
 });
 return {key,name,actions,folders};
}

test('project framing and optional task plan persist through editor save and reload',async({page})=>{
 await openFixture(page);await page.getByRole('button',{name:'Projects',exact:true}).click();await page.getByRole('button',{name:'New project',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Create project',exact:true}),name=`Synthetic framed project ${crypto.randomUUID()}`;
 await expect(dialog.getByLabel('What this project is and why',{exact:true})).toHaveValue('');await expect(dialog.getByRole('checkbox',{name:'Include my task plan in briefings',exact:true})).not.toBeChecked();
 await expect(dialog.getByLabel('What this project is and why',{exact:true})).toHaveAttribute('maxlength','2500');await dialog.getByLabel('Project name',{exact:true}).fill(name);
 await dialog.getByLabel('What this project is and why',{exact:true}).fill('Explain how this synthetic project helps its intended users.');await dialog.getByRole('checkbox',{name:'Include my task plan in briefings',exact:true}).check();await dialog.getByRole('button',{name:'Create project',exact:true}).click();await expect(dialog).not.toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{name:string})=>row.name===name);expect(project.framing).toBe('Explain how this synthetic project helps its intended users.');expect(project.includeTaskPlanInBriefings).toBe(true);
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);await page.getByRole('button',{name:'Edit project',exact:true}).click();const edit=page.getByRole('dialog',{name:'Edit project',exact:true});await expect(edit.getByLabel('What this project is and why',{exact:true})).toHaveValue(project.framing);await expect(edit.getByRole('checkbox',{name:'Include my task plan in briefings',exact:true})).toBeChecked();
});

test('folder creates and maps a blank project without running AI; briefing needs an explicit click after reload',async({page})=>{
 const folder=await registeredFolder(page);await openFixture(page);await page.goto('/?view=local-analysis');
 const create=page.getByRole('button',{name:'Create a project from this folder',exact:true});await expect(create).toBeEnabled();await create.click();await page.getByRole('dialog',{name:'Create a project from this folder',exact:true}).getByRole('button',{name:'Create project',exact:true}).click();
 await expect(page.getByRole('button',{name:'Brief this project',exact:true})).toBeEnabled();expect(folder.actions).toEqual([]);
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key));expect(project).toBeTruthy();expect(project.name).toBe(folder.name);expect(project.framing).toBe('');expect(project.includeTaskPlanInBriefings).toBe(false);
 await page.reload();await expect(page.getByRole('button',{name:'Create a project from this folder',exact:true})).toHaveCount(0);const brief=page.getByRole('button',{name:'Brief this project',exact:true});await expect(brief).toBeEnabled();expect(folder.actions).toEqual([]);
 await page.getByRole('combobox',{name:'Analyze with',exact:true}).selectOption('claude');await brief.click();await expect.poll(()=>folder.actions.length).toBe(1);expect(folder.actions[0]).toMatchObject({action:'brief',repositoryKey:folder.key,projectId:project.id,provider:'claude'});
});

test('an uncertain project save prevents duplicate creation until its original outcome is checked',async({page})=>{
 const folder=await registeredFolder(page);await openFixture(page);await page.goto('/?view=local-analysis');
 await page.route('**/api/workspace/mutations/*',route=>route.abort('failed'));const lost=await loseNextWorkspaceResponse(page);
 const create=page.getByRole('button',{name:'Create a project from this folder',exact:true});await expect(create).toBeEnabled();await create.click();await page.getByRole('dialog',{name:'Create a project from this folder',exact:true}).getByRole('button',{name:'Create project',exact:true}).click();
 await expect(page.getByRole('button',{name:'Check original save',exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Create a project from this folder',exact:true})).not.toBeVisible();expect(lost.lost()).toBe(true);expect(folder.actions).toEqual([]);
 expect((await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key))).toHaveLength(1);
 await page.unroute('**/api/workspace/mutations/*');await page.getByRole('button',{name:'Check original save',exact:true}).click();
 await expect(page.getByRole('button',{name:'Brief this project',exact:true})).toBeEnabled();expect(folder.actions).toEqual([]);
 expect((await workspace(page)).workspace.projects.filter((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key))).toHaveLength(1);
});

test('an archived folder association asks for project restoration and cannot create or run another request',async({page})=>{
 const folder=await registeredFolder(page);await openFixture(page);await page.goto('/?view=local-analysis');
 const create=page.getByRole('button',{name:'Create a project from this folder',exact:true});await expect(create).toBeEnabled();await create.click();await page.getByRole('dialog',{name:'Create a project from this folder',exact:true}).getByRole('button',{name:'Create project',exact:true}).click();await expect(page.getByRole('button',{name:'Brief this project',exact:true})).toBeEnabled();
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(folder.key));
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);await page.getByRole('button',{name:'Archive project',exact:true}).click();await expect(page.getByRole('heading',{name:'This project is archived',exact:true})).toBeVisible();
 await page.goto('/?view=local-analysis');await expect(page.getByText(`This folder is linked to an archived project. Restore ${folder.name} from Projects to request a briefing.`,{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Create a project from this folder',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Brief this project',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Analyze',exact:true})).toBeDisabled();await expect(page.getByRole('combobox',{name:'Save to project',exact:true})).toBeDisabled();expect(folder.actions).toEqual([]);
});

test('two PC folders join one framed project and remain listed after reload without inference',async({page},testInfo)=>{
 const registered=await registeredFolder(page,2),[app,lab]=registered.folders;await openFixture(page);await page.goto('/?view=local-analysis');
 const appCard=page.locator('article').filter({has:page.getByRole('heading',{name:app.name,exact:true})});await appCard.getByRole('button',{name:'Create a project from this folder',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Create a project from this folder',exact:true});
 await expect(dialog.getByLabel('What this project is and why',{exact:true})).toBeFocused();await dialog.getByLabel('What this project is and why',{exact:true}).fill('The app and its map lab deliver one clear map experience.');await dialog.getByRole('button',{name:'Create project',exact:true}).click();await expect(dialog).not.toBeVisible();
 const project=(await workspace(page)).workspace.projects.find((row:{personalRepositoryKeys?:string[]})=>row.personalRepositoryKeys?.includes(app.key));expect(project.framing).toContain('map lab');
 const labCard=page.locator('article').filter({has:page.getByRole('heading',{name:lab.name,exact:true})});await labCard.getByRole('combobox',{name:'Add to existing project',exact:true}).selectOption(project.id);await labCard.getByRole('button',{name:'Add folder to project',exact:true}).click();
 await expect.poll(async()=>(await workspace(page)).workspace.projects.find((row:{id:string})=>row.id===project.id).personalRepositoryKeys).toEqual([app.key,lab.key]);
 await page.goto(`/?view=projects&entity=project&id=${project.id}`);const folderList=page.getByRole('region',{name:'Project folders',exact:true});await expect(folderList.getByText(app.name,{exact:true})).toBeVisible();await expect(folderList.getByText(lab.name,{exact:true})).toBeVisible();await expect(folderList.getByRole('button',{name:'Add folder',exact:true})).toBeEnabled();expect(registered.actions).toEqual([]);
 await page.screenshot({path:testInfo.outputPath('multi-folder-project-synthetic.png'),fullPage:true});
});
