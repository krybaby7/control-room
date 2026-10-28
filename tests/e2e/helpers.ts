import {expect,type Page} from '@playwright/test';
export const fixtureOrigin='http://127.0.0.1:4173';
export async function setFixtureSession(page:Page,owner:'a'|'b'|'expired'){
 const response=await page.request.post(`/__test/session?owner=${owner}`,{headers:{Origin:fixtureOrigin}});expect(response.status()).toBe(204);
}
export async function openFixture(page:Page,owner:'a'|'b'='a'){
 await setFixtureSession(page,owner);await page.goto('/');await expect(page.getByRole('status').filter({hasText:/^Last saved /})).toBeVisible();
}
/** The real upstream request commits before its response is deliberately lost. */
export async function loseNextWorkspaceResponse(page:Page){
 let lost=false;let mutationId:string|undefined;
 await page.route('**/api/workspace',async route=>{
  if(route.request().method()!=='POST'||lost){await route.continue();return;}
  lost=true;mutationId=route.request().postDataJSON().mutationId;
  const response=await route.fetch();expect(response.ok()).toBeTruthy();await response.dispose();await route.abort('connectionreset');
 });
 return {mutationId:()=>mutationId,lost:()=>lost};
}
export async function workspace(page:Page){const response=await page.request.get('/api/workspace');expect(response.ok()).toBeTruthy();return response.json();}

/** Open Advanced from the actual main navigation; preserve native click/scroll behavior. */
export async function openAdvanced(page:Page){
 const navigation=page.getByRole('navigation',{name:'Main navigation',exact:true});
 // Reload paints the first screen before the saved URL view is applied. Wait for that
 // view's section before clicking, otherwise its restoration can race the click and
 // replace the intended navigation.
 const sections:Record<string,string>={home:'Home',projects:'Projects',needs:'Needs you'};
 const params=new URL(page.url()).searchParams,view=params.get('view')??(!params.has('entity')&&!params.has('subject')&&!params.has('review')?'home':null);
 if(view)await expect(navigation.getByRole('button',{name:sections[view]??'Advanced',exact:true})).toHaveAttribute('aria-current','page');
 await navigation.getByRole('button',{name:'Advanced',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Advanced',exact:true})).toBeVisible();
}
export type AdvancedToolName='Project lanes'|'Mission control'|'Weekly planning'|'Search'|'Attention'|'Inbox'|'Change many tasks at once'|'History'|'Evidence & decisions'|'Sources, export and restore'|'Repositories'|'Briefs & automations'|'Runtime'|'Agents';
const toolViews:Record<AdvancedToolName,string>={'Project lanes':'lanes','Mission control':'today','Weekly planning':'weekly',Search:'search',Attention:'attention',Inbox:'inbox','Change many tasks at once':'bulk',History:'history','Evidence & decisions':'evidence','Sources, export and restore':'sources',Repositories:'local-analysis','Briefs & automations':'reviews',Runtime:'runtime',Agents:'agents'};
/** Every detailed tool is one click under Advanced. A reload restores the open tool; as
 * clicking the current menu item did before, stay on it and prove it is the current tool
 * instead of leaving it while its own start-up guards may still hold navigation. */
export async function clickFixtureNavigation(page:Page,name:AdvancedToolName){
 const params=new URL(page.url()).searchParams;
 if(params.get('view')===toolViews[name]&&!params.has('entity')&&!params.has('subject')&&!params.has('review')){
  await expect(page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Advanced',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('.breadcrumb strong')).toHaveText(name);return;
 }
 await openAdvanced(page);await page.getByRole('main').getByRole('button',{name,exact:true}).click();
}
