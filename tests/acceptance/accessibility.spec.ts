import {expect,test,type Page,type TestInfo,type Locator} from '@playwright/test';
import {createRequire} from 'node:module';
import type {AxeResults} from 'axe-core';
import {fixtureOrigin,openFixture,workspace} from '../e2e/helpers';
import type {WorkspaceEnvelope} from '../../lib/types';
const axePath=createRequire(import.meta.url).resolve('axe-core/axe.min.js');
/** Actual locked axe-core, not a DOM heuristic. Synthetic owner pages only.
 * Automated scans do not certify assistive technology or physical-device access. */
async function scan(page:Page,info:TestInfo,stage:string){
 await page.addScriptTag({path:axePath});
 const result=await page.evaluate(async()=>{const engine=(window as Window&{axe:typeof import('axe-core')}).axe;return engine.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice']}});}) as AxeResults;
 expect(result.testEngine.version).toBe('4.11.4');
 const severe=result.violations.filter(rule=>rule.impact==='serious'||rule.impact==='critical');
 const report={source:process.env.CONTROL_ROOM_SOURCE_COMMIT??'local-source-not-recorded',scope:'synthetic-isolated-worker-only',browser:info.project.name,stage,viewport:page.viewportSize(),engine:result.testEngine,standardTags:['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice'],violations:result.violations.map(rule=>({id:rule.id,impact:rule.impact,help:rule.help,helpUrl:rule.helpUrl,nodes:rule.nodes.map(node=>({target:node.target,failureSummary:node.failureSummary}))})),incomplete:result.incomplete.map(rule=>({id:rule.id,impact:rule.impact,help:rule.help,nodes:rule.nodes.map(node=>({target:node.target,failureSummary:node.failureSummary}))})),limitations:['No physical phone/tablet or screen-reader certification.','Incomplete and lower-severity findings require human review.','No live provider, private hosted ingress or executor is exercised.']};
 await info.attach('axe-'+stage,{body:JSON.stringify(report,null,2),contentType:'application/json'});
 expect(severe.map(rule=>({id:rule.id,impact:rule.impact,targets:rule.nodes.map(node=>node.target)})),'Serious/critical axe findings at '+stage).toEqual([]);
}
async function trapped(page:Page,dialog:Locator){
 await expect(dialog).toBeVisible();
 const count=await dialog.locator('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]').count();expect(count).toBeGreaterThan(1);
 for(let index=0;index<count+2;index++){await page.keyboard.press('Tab');await expect.poll(()=>dialog.evaluate(node=>node.contains(document.activeElement))).toBe(true);}
 await page.keyboard.press('Shift+Tab');await expect.poll(()=>dialog.evaluate(node=>node.contains(document.activeElement))).toBe(true);
}
async function noHorizontalOverflow(page:Page){expect(await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)<=innerWidth+1)).toBe(true);}
for(const width of [390,768,1280])test('keyboard, landmarks and actual axe critical journeys at '+width+'px',async({page},info)=>{
 await page.setViewportSize({width,height:900});await openFixture(page);const before:WorkspaceEnvelope=await workspace(page);let ownerPosts=0;
 page.on('request',request=>{const path=new URL(request.url()).pathname;if(request.method()==='POST'&&['/api/workspace','/api/devices/enroll'].includes(path))ownerPosts++;});
 await expect(page.getByRole('main')).toHaveCount(1);await expect(page.getByRole('navigation',{name:'Main navigation',exact:true})).toHaveCount(1);
 await page.keyboard.press('Tab');const skip=page.getByRole('link',{name:'Skip to workspace',exact:true});await expect(skip).toBeFocused();await page.keyboard.press('Enter');await expect(page.getByRole('main')).toBeFocused();await noHorizontalOverflow(page);await scan(page,info,'today-'+width);
 await page.keyboard.press('Tab');const capture=page.getByRole('button',{name:'Capture',exact:true});await expect(capture).toBeFocused();await page.keyboard.press('Enter');const captureDialog=page.getByRole('dialog',{name:'Get it out of your head',exact:true});await expect(captureDialog.getByLabel('Title',{exact:true})).toBeFocused();await trapped(page,captureDialog);await scan(page,info,'capture-dialog-'+width);await page.keyboard.press('Escape');await expect(captureDialog).toHaveCount(0);await expect(capture).toBeFocused();
 const agents=page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Agents',exact:true});await agents.click();await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Configure execution budget',exact:true})).toBeEnabled();await noHorizontalOverflow(page);await scan(page,info,'agents-'+width);
 const budgetButton=page.getByRole('button',{name:'Configure execution budget',exact:true});await budgetButton.click();const budget=page.getByRole('dialog',{name:'Configure execution budget',exact:true});await expect(budget.getByLabel('Maximum jobs',{exact:true})).toHaveValue('0');await expect(budget.getByLabel('Enable this finite subscription budget',{exact:true})).not.toBeChecked();await trapped(page,budget);await budget.getByRole('button',{name:'Save execution budget',exact:true}).click();await expect(budget.getByRole('alert')).toContainText('Review this finite subscription-only budget before saving.');expect(ownerPosts).toBe(0);await scan(page,info,'budget-dialog-'+width);await page.keyboard.press('Escape');await expect(budget).toHaveCount(0);await expect(budgetButton).toBeFocused();
 const enrollButton=page.getByRole('button',{name:'Enroll execution device',exact:true});await enrollButton.click();const enrollment=page.getByRole('dialog',{name:'Enroll an executor or evaluation reader',exact:true});await expect(enrollment.getByLabel('Execution device label',{exact:true})).toHaveValue('');await expect(enrollment.getByRole('button',{name:'Create scoped enrollment',exact:true})).toBeDisabled();await expect(enrollment.getByLabel('Scoped enrollment secret',{exact:true})).toHaveCount(0);await trapped(page,enrollment);await scan(page,info,'enrollment-dialog-'+width);await page.keyboard.press('Escape');await expect(enrollment).toHaveCount(0);await expect(enrollButton).toBeFocused();
 expect(ownerPosts).toBe(0);const after:WorkspaceEnvelope=await workspace(page);expect(after.revision).toBe(before.revision);expect(after.workspace).toEqual(before.workspace);
});

test('native touch navigation and account controls are reachable without execution',async({browser,browserName},info)=>{
 test.skip(browserName==='firefox','Playwright Firefox does not support mobile/touch context emulation; its 390px keyboard journey runs separately.');
 const context=await browser.newContext({baseURL:fixtureOrigin,viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();let failed=false;await context.tracing.start({screenshots:true,snapshots:true,sources:false});try{await openFixture(page);const before:WorkspaceEnvelope=await workspace(page);let ownerPosts=0;page.on('request',request=>{if(request.method()==='POST'&&['/api/workspace','/api/devices/enroll'].includes(new URL(request.url()).pathname))ownerPosts++;});
 const sidebar=page.locator('aside.sidebar'),agents=sidebar.getByRole('button',{name:'Agents',exact:true});await agents.scrollIntoViewIfNeeded();await expect(agents).toBeInViewport();const bounds=await agents.boundingBox();expect(bounds?.height).toBeGreaterThanOrEqual(44);await agents.tap();await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Configure execution budget',exact:true})).toBeEnabled();
 const account=sidebar.getByRole('button',{name:'Account menu',exact:true});await account.tap();await expect(account).toHaveAttribute('aria-expanded','true');const signOut=sidebar.getByRole('link',{name:'Sign out',exact:true});await expect(signOut).toBeInViewport();await account.tap();await expect(signOut).toHaveCount(0);await noHorizontalOverflow(page);await scan(page,info,'touch-agents-390');expect(ownerPosts).toBe(0);expect((await workspace(page)).workspace).toEqual(before.workspace);
 }catch(error){failed=true;await info.attach('synthetic-touch-failure',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});throw error;}finally{await context.tracing.stop(failed?{path:info.outputPath('touch-trace.zip')}:{});await context.close();}
});
