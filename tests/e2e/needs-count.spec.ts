import {expect,test,type Page} from '@playwright/test';
import {fixtureOrigin,openFixture,workspace} from './helpers';

async function ownerCommand(page:Page,command:unknown){
 const before=await workspace(page);const issued=await page.request.post('/api/workspace/mutation-ids',{headers:{Origin:fixtureOrigin},data:{}});expect(issued.ok()).toBeTruthy();const {mutationId}=await issued.json();
 const response=await page.request.post('/api/workspace',{headers:{Origin:fixtureOrigin},data:{revision:before.revision,mutationId,command}});expect(response.ok(),await response.text()).toBeTruthy();
}
const waitingText=(count:number)=>`${count} thing${count===1?'':'s'} wait${count===1?'s':''} on you.`;
/** The total the Needs you screen states once saved briefings have been read. */
async function screenTotal(page:Page){
 await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Needs you',exact:true}).click();
 const region=page.locator('section.needs-you');await expect(region.getByRole('heading',{name:'Needs you',exact:true})).toBeVisible();await expect(region.getByText('Checking your latest briefings…',{exact:true})).toHaveCount(0);
 const summary=(await region.locator('.page-heading p').textContent())??'';if(summary==='Nothing waits on you right now.')return 0;
 const match=/^(\d+) things? waits? on you\.$/.exec(summary);expect(match,summary).toBeTruthy();return Number(match![1]);
}

test('the Needs you count in the menu matches the Needs you screen, follows saved changes and keeps the item name',async({page})=>{
 await openFixture(page,'b');
 const item=page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Needs you',exact:true}),count=item.locator('.nav-count');
 const before=await screenTotal(page);
 if(before){await expect(count).toHaveText(before>99?'99+':String(before));await expect(item).toHaveAccessibleDescription(waitingText(before));}else await expect(count).toHaveCount(0);
 // Two synthetic tasks waiting for review add exactly two items; nothing in the menu saves anything.
 const name=`Synthetic needs count ${crypto.randomUUID()}`;
 await ownerCommand(page,{type:'project.create',project:{name,description:'',goal:'',framing:'',includeTaskPlanInBriefings:false,color:'teal',repositories:[]}});
 const project=(await workspace(page)).workspace.projects.find((row:{name:string})=>row.name===name);expect(project).toBeTruthy();
 for(const suffix of ['first','second'])await ownerCommand(page,{type:'task.create',task:{projectId:project.id,milestoneId:null,title:`${name} ${suffix}`,notes:'Synthetic fixture only',status:'review',horizon:'now',priority:'normal',dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null}});
 await page.reload();const revision=(await workspace(page)).revision;
 const after=before+2;
 await expect(count).toHaveText(after>99?'99+':String(after));await expect(count).toHaveAttribute('aria-hidden','true');
 await expect(item).toHaveAccessibleName('Needs you');await expect(item).toHaveAccessibleDescription(waitingText(after));
 expect(await screenTotal(page)).toBe(after);expect((await workspace(page)).revision).toBe(revision);
 // On a phone the count sits inside its menu item and the page does not scroll sideways.
 await page.setViewportSize({width:390,height:844});await expect(count).toBeVisible();
 const [badge,button]=[await count.boundingBox(),await item.boundingBox()];expect(badge&&button).toBeTruthy();
 expect(badge!.x>=button!.x&&badge!.x+badge!.width<=button!.x+button!.width&&badge!.y>=button!.y&&badge!.y+badge!.height<=button!.y+button!.height).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
