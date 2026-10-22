import {test,expect,type Page} from '@playwright/test';
import {openFixture,workspace,clickFixtureNavigation} from './helpers';
const chunk=/\/[^/]*evidence-workspace[^/]*\.js(?:\?|$)/u;
async function holdPanel(page:Page){
 let release!:()=>void,entered!:()=>void,requests=0;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
 await page.route(chunk,async route=>{requests++;entered();await gate;await route.continue().catch(()=>{});});
 return {waiting,release,requests:()=>requests};
}
test('noninitial evidence code is requested only on selection and shows a useful loading state until the actual module arrives',async({page})=>{
 const held=await holdPanel(page);try{
  await openFixture(page);const before=await workspace(page);expect(held.requests()).toBe(0);
  await clickFixtureNavigation(page,'Evidence & decisions');await held.waiting;
  await expect(page.getByRole('status').filter({hasText:'Loading Evidence and decisions…'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Evidence and decisions',exact:true})).not.toBeVisible();
  held.release();await expect(page.getByRole('heading',{name:'Evidence and decisions',exact:true})).toBeVisible();
  expect((await workspace(page)).revision).toBe(before.revision);
 }finally{held.release();}
});
test('a failed actual panel import has a recoverable alert and explicit retry reloads only the selected module without a command or lost saved state',async({page})=>{
 let posts=0,blocked=0,navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});page.on('request',request=>{if(new URL(request.url()).pathname==='/api/workspace'&&request.method()==='POST')posts++;});
 await page.route(chunk,async route=>{blocked++;await route.abort('failed');});
 await openFixture(page);const before=await workspace(page);
 await clickFixtureNavigation(page,'Evidence & decisions');
 await expect(page.getByRole('heading',{name:'Evidence and decisions could not be loaded.',exact:true})).toBeVisible();expect(blocked).toBeGreaterThan(0);expect(posts).toBe(0);
 await page.unroute(chunk);const beforeRetryNavigations=navigations;
 await page.getByRole('button',{name:'Retry loading panel',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Evidence and decisions',exact:true})).toBeVisible();
 expect((await workspace(page)).revision).toBe(before.revision);expect(posts).toBe(0);expect(navigations).toBe(beforeRetryNavigations);
});
test('the bounded module deadline replaces a hung loading state and a late module cannot silently reopen the failed panel',async({page})=>{
 await page.clock.install();const held=await holdPanel(page);try{
  await openFixture(page);const before=await workspace(page);await clickFixtureNavigation(page,'Evidence & decisions');await held.waiting;
  await expect(page.getByRole('status').filter({hasText:'Loading Evidence and decisions…'})).toBeVisible();
  await page.clock.fastForward(15001);
  await expect(page.getByRole('heading',{name:'Evidence and decisions could not be loaded.',exact:true})).toBeVisible();
  held.release();await page.unroute(chunk);
  await expect(page.getByRole('heading',{name:'Evidence and decisions',exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'Retry loading panel',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Evidence and decisions',exact:true})).toBeVisible();
  expect((await workspace(page)).revision).toBe(before.revision);
 }finally{held.release();}
});
