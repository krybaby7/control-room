import {expect,test} from '@playwright/test';
import {openFixture,workspace} from './helpers';
import type {Workspace} from '../../lib/types';

test('mission control shows the status strip, project tiles, live operations and attention without saving',async({page})=>{
 await openFixture(page);const before=await workspace(page);const saved=before.workspace as Workspace;
 await expect(page.getByRole('heading',{name:'Mission control',exact:true})).toBeVisible();
 const hud=page.getByRole('region',{name:'Status overview',exact:true});
 await expect(hud.getByRole('button').filter({hasText:/^PC /})).toBeVisible();
 await expect(hud.getByRole('button').filter({hasText:/Personal PC app/})).toBeVisible();
 await expect(hud.getByRole('button').filter({hasText:/agent working|working|queued/})).toBeVisible();
 await expect(hud.getByRole('button').filter({hasText:/Codex Cloud/})).toBeVisible();
 await expect(hud.getByRole('button').filter({hasText:/need you|Nothing waiting/})).toBeVisible();
 // The feed footer reports a check time once the read-only feeds settled (or names the ones that failed).
 await expect(hud.getByRole('status')).toContainText(/checked \d\d:\d\d Cairo|could not be read/,{timeout:20000});
 for(const project of saved.projects.filter(row=>!row.archivedAt)){
  const tile=page.getByRole('article',{name:`Project ${project.name}`,exact:true});await expect(tile).toBeVisible();
  await expect(tile.getByRole('progressbar',{name:/^Milestones achieved/})).toBeVisible();
  await expect(tile.getByRole('progressbar',{name:/^Tasks completed/})).toBeVisible();
  await expect(tile.getByRole('status')).toContainText(/No agent working|Agent|Awaiting your approval|Run needs reconciliation/);
  await expect(tile.getByRole('button',{name:'Open project',exact:true})).toBeVisible();
 }
 await expect(page.getByRole('region',{name:'Live operations',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Needs you',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Mission log',exact:true})).toBeVisible();
 await expect(page.locator('.next-panel').getByRole('button',{name:'All ready work',exact:true})).toBeVisible();
 if(process.env.MISSION_CONTROL_SCREENSHOT)await page.screenshot({path:process.env.MISSION_CONTROL_SCREENSHOT,fullPage:true});
 // Opening a project from its tile navigates without any save.
 const first=saved.projects.find(row=>!row.archivedAt)!;
 await page.getByRole('article',{name:`Project ${first.name}`,exact:true}).getByRole('button',{name:'Open project',exact:true}).click();
 await expect(page.getByRole('heading',{name:first.name,exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'Today',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Mission control',exact:true})).toBeVisible();
 expect((await workspace(page)).revision).toBe(before.revision);
});
