import { test, expect, type Page } from '@playwright/test';
import { fixtureOrigin, openFixture, workspace } from './helpers';
import type { Workspace } from '../../lib/types';

async function command(page:Page,value:unknown,endpoint='/api/workspace') {
  const before=await workspace(page);
  const issued=await page.request.post('/api/workspace/mutation-ids',{headers:{Origin:fixtureOrigin},data:{}});
  expect(issued.ok()).toBeTruthy();const {mutationId}=await issued.json();
  const response=await page.request.post(endpoint,{headers:{Origin:fixtureOrigin},data:{revision:before.revision,mutationId,command:value}});
  expect(response.ok(),await response.text()).toBeTruthy();return response.json();
}

test('copyable Unicode search restores all filters and page through reload, history, and task closure',async({page})=>{
  await openFixture(page);const before=await workspace(page),incoming:Workspace=structuredClone(before.workspace);
  const project=incoming.projects.find(row=>!row.archivedAt)!,prefix=`search-state-${crypto.randomUUID()}`,now=new Date().toISOString();
  const ids=Array.from({length:60},(_,index)=>`${prefix}_${String(index).padStart(3,'0')}`);
  const titles=ids.map((_,index)=>`${prefix} مرحبا ${String(index).padStart(3,'0')}`);
  for(const [index,id] of ids.entries())incoming.tasks.push({id,projectId:project.id,milestoneId:null,title:titles[index],notes:'Synthetic URL state browser fixture',status:'proposed',horizon:'next',priority:'normal',dueDate:null,weekly:false,weeklyWeek:null,dependsOn:[],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null,createdAt:now,updatedAt:now,completedAt:null,archivedFromStatus:null});
  const staged=await page.request.post('/api/workspace/imports',{headers:{Origin:fixtureOrigin,'Content-Type':'application/json'},data:Buffer.from(JSON.stringify(incoming))});expect(staged.ok()).toBeTruthy();const stage=await staged.json();expect(stage.diagnostics).toHaveLength(0);
  await command(page,{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:before.revision,mode:'merge',selection:{projects:[],milestones:[],tasks:ids,captures:[],activity:[]}},`/api/workspace/imports/${stage.id}/commit`);
  await command(page,{type:'task.bulk',ids,patch:{status:'review'}});await page.reload();
  await page.getByRole('button',{name:'Search',exact:true}).click();const query=`${prefix} مرحبا`;
  await page.getByLabel('Search text',{exact:true}).fill(query);
  await page.getByLabel('Record type',{exact:true}).selectOption('task');await page.getByLabel('Project',{exact:true}).selectOption(project.id);await page.getByLabel('Saved status',{exact:true}).selectOption('review');await page.getByRole('checkbox',{name:'Include archived records and work in archived projects or milestones',exact:true}).check();
  const navigation=page.getByRole('navigation',{name:'Search result pages'});
  await navigation.getByRole('button',{name:'Next page',exact:true}).click();await expect(navigation.getByText('Page 2 of 2',{exact:true})).toBeVisible();
  const savedUrl=page.url(),params=new URL(savedUrl).searchParams;
  expect(Object.fromEntries(params)).toEqual({view:'search',q:query,type:'task',project:project.id,status:'review',archived:'1',page:'2'});
  const assertState=async(current:Page)=>{await expect(current.getByLabel('Search text',{exact:true})).toHaveValue(query);await expect(current.getByLabel('Record type',{exact:true})).toHaveValue('task');await expect(current.getByLabel('Project',{exact:true})).toHaveValue(project.id);await expect(current.getByLabel('Saved status',{exact:true})).toHaveValue('review');await expect(current.getByRole('checkbox',{name:'Include archived records and work in archived projects or milestones',exact:true})).toBeChecked();await expect(current.getByRole('navigation',{name:'Search result pages'}).getByText('Page 2 of 2',{exact:true})).toBeVisible();await expect(current.getByRole('link',{name:titles[59],exact:true})).toBeVisible();};
  await page.reload();await assertState(page);expect(page.url()).toBe(savedUrl);
  const copied=await page.context().newPage();await copied.goto(savedUrl);await assertState(copied);await copied.close();
  await navigation.getByRole('button',{name:'Previous page',exact:true}).click();await expect(navigation.getByText('Page 1 of 2',{exact:true})).toBeVisible();await page.goBack();await assertState(page);await page.goForward();await expect(navigation.getByText('Page 1 of 2',{exact:true})).toBeVisible();await page.goBack();await assertState(page);
  await page.getByRole('link',{name:titles[59],exact:true}).click();const editor=page.getByRole('dialog',{name:'Edit task',exact:true});await expect(editor).toBeVisible();expect(new URL(page.url()).searchParams.get('id')).toBe(ids[59]);await editor.getByRole('button',{name:'Close editor',exact:true}).click();await expect(editor).not.toBeVisible();await assertState(page);await expect(page).toHaveURL(savedUrl);
  await page.getByRole('button',{name:'Projects',exact:true}).click();await page.goBack();await assertState(page);await expect(page).toHaveURL(savedUrl);
});
