import {expect,test} from '@playwright/test';
import {openFixture,workspace} from './helpers';
import {capturePostResponse} from './server-response';
import type {WorkspaceEnvelope} from '../../lib/types';

for(const height of [720,600])test(`short desktop sidebar keeps Quick capture and account reachable with native scrolling at 1280×${height}`,async({page})=>{
 await page.setViewportSize({width:1280,height});await openFixture(page,'a');const sidebar=page.locator('aside.sidebar'),navigation=sidebar.getByRole('navigation',{name:'Main navigation',exact:true});await expect(navigation.getByRole('button',{name:'Briefs & automations',exact:true})).toBeVisible();
 // Wheel and locator scrolling use the real scroll container; no style/DOM changes or forced clicks.
 await sidebar.hover();await page.mouse.wheel(0,1000);const quick=sidebar.getByRole('button',{name:'Quick capture',exact:true});await quick.scrollIntoViewIfNeeded();await expect(quick).toBeInViewport();await quick.click();
 const dialog=page.getByRole('dialog',{name:'Get it out of your head',exact:true});await expect(dialog).toBeVisible();const title=`Synthetic sidebar capture ${height} ${crypto.randomUUID()}`;await dialog.getByRole('textbox',{name:'Title',exact:true}).fill(title);
 // Confirm the capture so this navigation regression leaves no unresolved new-capture draft for later journeys.
 const saved=await capturePostResponse(page,'/api/workspace',()=>dialog.getByRole('button',{name:'Capture it',exact:true}).click());expect(saved.ok,saved.body.toString()).toBeTruthy();expect((saved.submitted as {command:unknown}).command).toMatchObject({type:'capture.create',capture:{title}});await expect(dialog).toHaveCount(0);const current:WorkspaceEnvelope=await workspace(page);expect(current.workspace.captures.filter(row=>row.title===title)).toHaveLength(1);
 await sidebar.hover();await page.mouse.wheel(0,1000);const account=sidebar.getByRole('button',{name:'Account menu',exact:true});await account.scrollIntoViewIfNeeded();await expect(account).toBeInViewport();await account.click();const signOut=sidebar.getByRole('link',{name:'Sign out',exact:true});await signOut.scrollIntoViewIfNeeded();await expect(signOut).toBeInViewport();await expect(account).toHaveAttribute('aria-expanded','true');await account.click();await expect(signOut).toHaveCount(0);
});
