import {test,expect} from '@playwright/test';
import {openFixture,setFixtureSession,loseNextWorkspaceResponse,workspace} from './helpers';

test('capture commits exactly once after the real committed response is lost',async({page})=>{
 await openFixture(page);const title=`Synthetic lost-response ${crypto.randomUUID()}`;const before=await workspace(page);const lost=await loseNextWorkspaceResponse(page);
 await page.getByRole('button',{name:'Quick capture',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill(title);await page.getByRole('button',{name:'Capture it',exact:true}).click();
 await expect(page.getByRole('dialog')).not.toBeVisible();expect(lost.lost()).toBe(true);expect(lost.mutationId()).toBeTruthy();const after=await workspace(page);expect(after.revision).toBe(before.revision+1);expect(after.workspace.captures.filter((row:{title:string})=>row.title===title)).toHaveLength(1);
 const outcome=await page.request.get(`/api/workspace/mutations/${lost.mutationId()}`);expect(outcome.ok()).toBeTruthy();expect((await outcome.json()).status).toBe('committed');
 await page.reload();const reloaded=await workspace(page);expect(reloaded.workspace.captures.filter((row:{title:string})=>row.title===title)).toHaveLength(1);
});
test('server draft survives reload and remains isolated from another owner',async({page})=>{
 await openFixture(page);const title=`Synthetic durable draft ${crypto.randomUUID()}`;
 await page.getByRole('button',{name:'Quick capture',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill(title);await expect(page.getByText('Draft saved',{exact:false})).toBeVisible();
 page.on('dialog',dialog=>dialog.accept());await page.reload();await page.getByRole('button',{name:'Quick capture',exact:true}).click();await page.getByRole('button',{name:'Recover draft',exact:true}).click();await expect(page.getByLabel('Title',{exact:true})).toHaveValue(title);
 await setFixtureSession(page,'b');await page.reload();await page.getByRole('button',{name:'Quick capture',exact:true}).click();await expect(page.getByLabel('Title',{exact:true})).toHaveValue('');
 await setFixtureSession(page,'a');await page.reload();await page.getByRole('button',{name:'Quick capture',exact:true}).click();await page.getByRole('button',{name:'Recover draft',exact:true}).click();await expect(page.getByLabel('Title',{exact:true})).toHaveValue(title);
});
test('expired session hides private content after an authenticated request fails',async({page})=>{
 await openFixture(page);await expect(page.getByText('Synthetic project',{exact:false}).first()).toBeVisible();await setFixtureSession(page,'expired');
 // A normal focus refresh uses the production request/401 path.
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByRole('heading',{name:'Your session has expired.'})).toBeVisible();await expect(page.getByText('Synthetic project',{exact:false})).toHaveCount(0);await expect(page.getByRole('button',{name:'Quick capture',exact:true})).toBeDisabled();
});
