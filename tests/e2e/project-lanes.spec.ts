import {test,expect} from '@playwright/test';
import {openFixture,workspace} from './helpers';
import {createLanesFixture,installLanesOverview,type LanesFixture} from './fixtures/project-lanes';
// UI-only routed story/coverage fixtures exercise real production components.
// Native owner planning commands run against the isolated fixture worker.
let fixture:LanesFixture;
test.beforeAll(async({browser})=>{const page=await browser.newPage();try{fixture=await createLanesFixture(page);}finally{await page.close();}});
test('default project lanes exposes cited finished/open/next and separate observed versus owner acceptance',async({page})=>{
 await openFixture(page,'b');const routed=await installLanesOverview(page,fixture);await page.reload();const before=await workspace(page);
 await expect(page.getByRole('heading',{name:'Your projects',exact:true})).toBeVisible();await expect(page.locator('.next-panel')).toHaveCount(0);
 const project=page.locator('.project-lane-card').filter({has:page.getByRole('heading',{name:fixture.projectName,exact:true})}),map=project.locator('.project-lane').filter({has:page.locator('.project-lane-toggle strong',{hasText:/^Map$/})});
 const toggle=map.locator('.project-lane-toggle');await expect(toggle).toHaveAttribute('aria-expanded','false');await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-expanded','true');
 await expect(map.locator('.area-story h4')).toHaveText(['Finished','Still open','Next','Unknowns and gaps']);await expect(map.getByText('Synthetic software checks passed',{exact:false})).toBeVisible();await expect(map).toContainText('Observed · acceptance not recorded');await expect(map).toContainText('1 of 2 checkpoints accepted');
 await expect(map.locator('[aria-label="Device acceptance: observed verified; not owner accepted"]')).toBeVisible();await expect(map.getByText('Physical device acceptance still needs an owner decision',{exact:false})).toBeVisible();
 await expect(map.locator('.task-context')).toContainText(`${fixture.projectName} / Map / Review`);
 const android=project.locator('.project-lane').filter({has:page.locator('.project-lane-toggle strong',{hasText:/^Android testing$/})});await android.locator('.project-lane-toggle').click();await expect(android.locator('.task-context')).toContainText(`${fixture.projectName} / Android testing / Planning`);
 expect(routed.reads()).toBeGreaterThan(0);expect((await workspace(page)).revision).toBe(before.revision);
});
test('all four source classes and partial cloud counts remain visible without claiming unattended verification',async({page})=>{
 await openFixture(page,'b');await installLanesOverview(page,fixture);await page.reload();await page.locator('.history-status summary').click();const coverage=page.locator('.history-status');for(const label of ['Codex local','Codex cloud','Claude Code local','Claude Code cloud'])await expect(coverage.getByRole('heading',{name:label,exact:true})).toBeVisible();
 await expect(coverage).toContainText('3 discovered · 1 read completely · 1 partial · 1 unavailable · 1 unresolved gaps');await expect(coverage).toContainText('Awaiting verification');await expect(coverage).toContainText('Unattended: awaiting verification');await expect(coverage).toContainText('Synthetic unavailable retained cloud segment');await expect(coverage).not.toContainText('All caught up');
});
test('retained evidence pages preserve exact citation identity and show unsupported native links honestly',async({page})=>{
 await openFixture(page,'b');await installLanesOverview(page,fixture);const offsets:string[]=[];await page.route('**/api/history/citation?**',async route=>{const url=new URL(route.request().url());expect(url.searchParams.get('messageRevisionId')).toBe(fixture.citation.messageRevisionId);expect(url.searchParams.get('revisionDigest')).toBe(fixture.citation.revisionDigest);expect(url.searchParams.get('start')).toBe('0');expect(url.searchParams.get('end')).toBe('5');const offset=url.searchParams.get('offset')??'0';offsets.push(offset);await route.fulfill({status:200,json:{text:offset==='0'?'Synthetic retained context. '.repeat(800).slice(0,16000):'Last span.',quote:'First',context:{sourceLabel:'Synthetic UI retained source',conversationTitle:'Synthetic retained conversation',occurredAt:null,nativeLink:null},availability:'complete',codePointOffset:Number(offset),nextOffset:offset==='0'?16000:null,totalCodePoints:16010,reason:null}});});
 await page.reload();const project=page.locator('.project-lane-card').filter({has:page.getByRole('heading',{name:fixture.projectName,exact:true})});await project.locator('.project-lane-toggle').filter({hasText:'Map'}).click();await project.locator('.area-story').getByRole('button',{name:/Read evidence 1/}).first().click();const dialog=page.getByRole('dialog',{name:'Retained source context',exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText('No verified native source link is available.');await dialog.getByRole('button',{name:'Load next retained span',exact:true}).click();await expect(dialog.locator('pre')).toHaveText('Last span.');expect(offsets).toEqual(['0','16000']);await dialog.getByRole('button',{name:'Read retained context from beginning',exact:true}).click();await expect(dialog).toContainText('Retained context offset: 0');await dialog.getByRole('button',{name:'Close context',exact:true}).click();await expect(dialog).not.toBeVisible();
});
test('narrow viewport and 200 percent zoom retain keyboard access without horizontal document scrolling',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});await openFixture(page,'b');await installLanesOverview(page,fixture);await page.reload();const project=page.locator('.project-lane-card').filter({has:page.getByRole('heading',{name:fixture.projectName,exact:true})});await project.locator('.project-lane-toggle').filter({hasText:'Map'}).focus();await page.keyboard.press('Enter');await expect(project.getByRole('heading',{name:'Finished',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath('project-lanes-390-synthetic.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await expect(project.getByRole('heading',{name:'Finished',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath('project-lanes-1440-synthetic.png'),fullPage:true});await page.evaluate(()=>{document.documentElement.style.zoom='2';});await expect(project.locator('.project-lane-toggle').filter({hasText:'Map'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath('project-lanes-200-percent-synthetic.png'),fullPage:true});
});


// Routed workspace/overview fixtures below test layout only. They never clear or
// extend the isolated owner's stored projects and are not live history evidence.
test('many long-named synthetic areas wrap at 390px and the last area is keyboard reachable',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});await openFixture(page,'b');
 const before=await workspace(page),display=structuredClone(before),routed=await installLanesOverview(page,fixture);
 const extra=Array.from({length:18},(_,index)=>({id:`synthetic-layout-area-${index}`,projectId:fixture.projectId,name:`Synthetic ${String(index+1).padStart(2,'0')} long area — Android acceptance and map review across retained conversation boundaries`,aliases:[],order:100+index,archivedAt:null}));
 display.workspace.areas=[...(display.workspace.areas??[]),...extra];
 await page.route('**/api/workspace',async route=>{if(route.request().method()==='GET')await route.fulfill({status:200,json:display});else await route.continue();});
 await page.reload();const project=page.locator('.project-lane-card').filter({has:page.getByRole('heading',{name:fixture.projectName,exact:true})}),toggles=project.locator('.project-lane-toggle');
 await expect(toggles).toHaveCount(20);await toggles.first().focus();
 for(let index=1;index<20;index++)await page.keyboard.press('Tab');
 const last=toggles.last();await expect(last).toBeFocused();await expect(last.locator('strong')).toHaveText(extra.at(-1)!.name);await expect(last).toHaveAttribute('aria-expanded','false');await page.keyboard.press('Enter');await expect(last).toHaveAttribute('aria-expanded','true');await expect(project.getByText('No tasks in this area.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath('project-lanes-many-long-areas-390-synthetic.png'),fullPage:true});
 expect(routed.reads()).toBeGreaterThan(0);expect((await workspace(page)).workspace).toEqual(before.workspace);expect((await workspace(page)).revision).toBe(before.revision);
});

test('routed empty synthetic workspace keeps capture reachable without clearing owner records',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});await openFixture(page,'b');const before=await workspace(page),display={...before,workspace:{schemaVersion:5,projects:[],areas:[],milestones:[],tasks:[],captures:[],activity:[]}};
 await page.route('**/api/workspace',async route=>{if(route.request().method()==='GET')await route.fulfill({status:200,json:display});else await route.continue();});
 await page.route('**/api/history/overview',route=>route.fulfill({status:200,json:{planningRevision:before.revision,sourceWatermark:'synthetic-empty-ui-only',progress:[],stories:[],scopes:[],workItems:[],claims:[],unassignedConversations:[],associationRules:[],unassignedHistoryCount:0,sources:[],configurations:[]}}));
 await page.reload();await expect(page.getByRole('heading',{name:'Your projects',exact:true})).toBeVisible();await expect(page.locator('.project-lane-card')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'Loading project history…'})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);const capture=page.getByRole('button',{name:'Capture +',exact:true});await expect(capture).toBeEnabled();await capture.focus();await expect(capture).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath('project-lanes-empty-390-synthetic.png'),fullPage:true});
 expect((await workspace(page)).workspace).toEqual(before.workspace);expect((await workspace(page)).revision).toBe(before.revision);
});
