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
