import {test,expect} from '@playwright/test';
import {openFixture,workspace} from './helpers';
import {getRecommendations} from '../../lib/planning';
import {cairoDate} from '../../lib/calendar';
import type {Workspace} from '../../lib/types';

test('all ready work exposes the complete ordered queue and returns to a six-task preview without saving',async({page})=>{
 await openFixture(page);const before=await workspace(page);const saved=before.workspace as Workspace;const expected=getRecommendations(saved,cairoDate(new Date())).map(row=>saved.tasks.find(task=>task.id===row.taskId)!);
 const panel=page.locator('.next-panel');await expect(panel.locator('.task-title')).toHaveCount(Math.min(6,expected.length));const open=panel.getByRole('button',{name:'All ready work',exact:true});await open.focus();await page.keyboard.press('Enter');await expect(panel.getByRole('heading',{name:new RegExp(`^All ready work ${expected.length}$`)})).toBeVisible();const titles:string[]=[];
 for(let index=0;index<Math.max(1,Math.ceil(expected.length/50));index++){
  await expect(panel.getByRole('status')).toContainText(`of ${expected.length} ready tasks`);await expect(panel.locator('.task-title')).toHaveCount(Math.min(50,Math.max(0,expected.length-index*50)));titles.push(...await panel.locator('.task-title').allTextContents());
  if(index<Math.ceil(expected.length/50)-1){const next=panel.getByRole('button',{name:'Next ready work page',exact:true});await next.focus();await page.keyboard.press('Enter');}
 }
 expect(titles).toEqual(expected.map(task=>task.title));const ready=new Set(expected.map(task=>task.id));for(const project of saved.projects.filter(project=>!project.archivedAt&&!saved.tasks.some(task=>task.projectId===project.id&&ready.has(task.id))))await expect(panel.getByRole('region',{name:'Projects with no ready work',exact:true}).getByRole('heading',{name:project.name,exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'Return to next up preview',exact:true}).click();await expect(panel.locator('.task-title')).toHaveCount(Math.min(6,expected.length));await expect(panel.getByRole('status')).toContainText('Six-task preview');expect((await workspace(page)).revision).toBe(before.revision);
});
