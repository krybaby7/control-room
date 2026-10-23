import {expect,test} from '@playwright/test';
import {fixtureOrigin,openFixture,workspace,clickFixtureNavigation} from './helpers';
import type {WorkspaceEnvelope} from '../../lib/types';
import type {JobReadModel} from '../../lib/agents/read-model';
test('native exact owner job history reads the frozen proposal and redacts on session expiry without execution or acceptance',async({page})=>{
 await openFixture(page);
 const before:WorkspaceEnvelope=await workspace(page),task=before.workspace.tasks.find(row=>row.status!=='archived'&&row.projectId&&before.workspace.projects.some(project=>project.id===row.projectId&&!project.archivedAt));expect(task).toBeTruthy();
 const ticket=await page.request.post('/api/workspace/mutation-ids',{headers:{Origin:fixtureOrigin},data:{}});expect(ticket.ok()).toBeTruthy();const {mutationId}=await ticket.json();
 const repositoryKey='history-'+crypto.randomUUID(),created=await page.request.post('/api/workspace',{headers:{Origin:fixtureOrigin},data:{revision:before.revision,mutationId,command:{type:'jobs.create',value:{operation:'project.inspect',projectId:task!.projectId,taskId:task!.id,repositoryKey,baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'synthetic-exact-model',effort:'medium',timeoutSeconds:30,outputBytesLimit:4096,dependsOnJobIds:[]}}}});expect(created.ok(),await created.text()).toBeTruthy();
 const readResponse=await page.request.get('/api/jobs');expect(readResponse.ok()).toBeTruthy();const read=await readResponse.json() as JobReadModel,job=read.jobs.find(row=>row.record.spec.repositoryKey===repositoryKey);expect(job).toBeTruthy();
 await page.reload();await clickFixtureNavigation(page,'Agents');
 // The queue's existing task label can identify multiple proposals. Select the
 // unique ordered item matching the actual owner response, without DOM mutation.
 const queue=page.getByRole('region',{name:'Agent job queue'}),index=read.jobs.findIndex(row=>row.record.id===job!.record.id);
 const historyResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs/'+job!.record.id&&response.request().method()==='GET');
 for(let pageIndex=0;pageIndex<Math.floor(index/100);pageIndex++)await queue.getByRole('button',{name:'Next 100 jobs',exact:true}).click();
 await queue.locator('button.capture-preview').nth(index%100).click();
 expect((await historyResponse).ok()).toBeTruthy();
 const detail=page.getByRole('article',{name:'Agent job '+job!.record.id,exact:true}),history=detail.getByRole('region',{name:'Private job history'});
 await expect(detail).toContainText(repositoryKey);await expect(detail).toContainText(job!.record.specSha256);await expect(history).toContainText('No result artifacts are recorded.');await expect(history).toContainText('No private attempt events are available.');
 await expect(history.locator('a')).toHaveCount(0);await expect(detail.getByRole('button',{name:'Accept result evidence',exact:true})).toHaveCount(0);
 const after:WorkspaceEnvelope=await workspace(page);expect(after.workspace).toEqual(before.workspace);expect(after.revision).toBe(before.revision+1);
 const forged=await page.request.get('/api/jobs/'+job!.record.id+'/events?attemptId=foreign-attempt&ownerId=other');expect(forged.status()).toBe(400);
 await page.evaluate(()=>window.dispatchEvent(new Event('control-room-session-expired')));
 await expect(page.getByRole('article',{name:'Agent job '+job!.record.id,exact:true})).toHaveCount(0);
 await expect(page.getByText(repositoryKey,{exact:false})).toHaveCount(0);
});
