import {test,expect,type Page} from '@playwright/test';
import {openFixture,workspace,clickFixtureNavigation} from './helpers';
const chunk=/\/[^/]*evidence-workspace[^/]*\.js(?:\?|$)/u;
async function holdPanel(page:Page,selected=chunk){
 let release!:()=>void,entered!:()=>void,requests=0;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
 await page.route(selected,async route=>{requests++;entered();await gate;await route.continue().catch(()=>{});});
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
test('a panel chunk removed by a newer deployment explains the update and an explicit reload opens the current version at the same view',async({page})=>{
 let posts=0,navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});page.on('request',request=>{if(new URL(request.url()).pathname==='/api/workspace'&&request.method()==='POST')posts++;});
 // A redeploy removed this tab's hashed chunks: the panel import and the page's own chunk now 404.
 const running=/\/[^/]*control-center[^/]*\.js(?:\?|$)/u;let probes=0;
 await page.route(chunk,route=>route.fulfill({status:404,contentType:'text/plain',body:'Not Found'}));
 await openFixture(page);const before=await workspace(page);
 await page.route(running,async route=>{if(route.request().method()!=='HEAD'){await route.continue();return;}probes++;await route.fulfill({status:404,contentType:'text/plain',body:''});});
 await clickFixtureNavigation(page,'Evidence & decisions');
 const alert=page.getByRole('alert').filter({has:page.getByRole('heading',{name:'Evidence and decisions could not be loaded.',exact:true})});
 await expect(alert).toContainText('This tab is running a Control Room version that is no longer deployed');expect(probes).toBeGreaterThan(0);
 await expect(alert.getByRole('button',{name:'Retry loading panel',exact:true})).toHaveCount(0);
 await page.unroute(chunk);await page.unroute(running);const beforeReloadNavigations=navigations;
 await alert.getByRole('button',{name:'Reload Control Room',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Evidence and decisions',exact:true})).toBeVisible();
 expect(navigations).toBeGreaterThan(beforeReloadNavigations);expect(new URL(page.url()).searchParams.get('view')).toBe('evidence');
 expect((await workspace(page)).revision).toBe(before.revision);expect(posts).toBe(0);
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

test('Today code stays off the initial lanes path and selection retains loading feedback and saved owner state',async({page})=>{
 const held=await holdPanel(page,/\/[^/]*mission-control[^/]*\.js(?:\?|$)/u);let posts=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/workspace'&&request.method()==='POST')posts++;});
 try{await openFixture(page);await expect(page.getByRole('heading',{name:'Your projects',exact:true})).toBeVisible();const before=await workspace(page);expect(held.requests()).toBe(0);
  await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Today',exact:true}).click();await held.waiting;await expect(page.getByRole('status').filter({hasText:'Loading Today…'})).toBeVisible();await expect(page.getByRole('heading',{name:'Mission control',exact:true})).not.toBeVisible();
  held.release();await expect(page.getByRole('heading',{name:'Mission control',exact:true})).toBeVisible();expect((await workspace(page)).revision).toBe(before.revision);expect(posts).toBe(0);
 }finally{held.release();}
});
