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

/** Open the actual secondary navigation disclosure; preserve native click/scroll behavior. */
export async function openFixtureDetails(page:Page){
 const navigation=page.getByRole('navigation',{name:'Main navigation',exact:true});
 // Reload initially renders lanes before the saved URL view is applied. Wait for
 // that view before inspecting open, otherwise its restoration can race the click
 // and turn an intended disclosure-open action into a close action.
 const labels:Record<string,string>={lanes:'Project lanes','local-analysis':'Repositories',today:'Today',projects:'Projects',inbox:'Inbox',weekly:'Weekly',search:'Search',attention:'Attention',history:'History',evidence:'Evidence & decisions',sources:'Sources',reviews:'Briefs & automations',runtime:'Runtime',agents:'Agents'};
 const params=new URL(page.url()).searchParams,view=params.get('view')??(!params.has('entity')&&!params.has('subject')&&!params.has('review')?'lanes':null);
 if(view&&labels[view])await expect(navigation.getByRole('button',{name:labels[view],exact:true,includeHidden:true})).toHaveAttribute('aria-current','page');
 const details=navigation.locator('details');if(!await details.evaluate(node=>(node as HTMLDetailsElement).open))await details.locator('summary').click();
 await expect(details).toHaveAttribute('open','');
}
export async function clickFixtureNavigation(page:Page,name:'Agents'|'Runtime'|'Sources'|'Attention'|'History'|'Evidence & decisions'|'Briefs & automations'){await openFixtureDetails(page);await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name,exact:true}).click();}
