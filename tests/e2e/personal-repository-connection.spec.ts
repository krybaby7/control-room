import {test,expect,type Page} from '@playwright/test';
import {setFixtureSession,openFixture,workspace} from './helpers';
// Synthetic PC presence only: the fixture has no personal connector, so no device or provider is involved.
const providers={codex:{ready:true,detail:'ready'},claude:{ready:false,detail:'auth_required'}};
const lastSeenAt='2026-10-20T08:00:00.000Z';
async function pcPresence(page:Page){
 let online=false,reads=0;
 await page.route('**/api/personal-repositories',async route=>{if(route.request().method()!=='GET'){await route.abort('failed');return;}reads++;await route.fulfill({json:{configured:true,connected:true,online,lastSeenAt:online?new Date().toISOString():lastSeenAt,providers,repositories:[],jobs:[],completedReport:null}});});
 return {reads:()=>reads,connect:()=>{online=true;}};
}
async function openRepositories(page:Page){
 await setFixtureSession(page,'a');await page.goto('/?view=local-analysis&projectId=synthetic-project');
 await expect(page.getByRole('heading',{name:'Repositories',exact:true})).toBeVisible();
}
const offline=/^Your PC is offline \(last seen .+\)\. Open Control Room on this PC to continue\.$/u;

test('Analyze on a Today project opens Repositories with that project explained as the analysis target',async({page})=>{
 await pcPresence(page);await openFixture(page);
 await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Today',exact:true}).click();
 await page.getByRole('button',{name:'Analyze',exact:true}).first().click();
 await expect(page.getByRole('heading',{name:'Repositories',exact:true})).toBeVisible();
 const projectId=new URL(page.url()).searchParams.get('projectId'),project=(await workspace(page)).workspace.projects.find((p:{id:string})=>p.id===projectId);
 expect(project).toBeTruthy();await expect(page.getByText(`Analyzing ${project.name}. Analysis runs on your PC`)).toBeVisible();
});

test('an offline PC shows when it was last seen and Refresh connection visibly reports a new check',async({page})=>{
 const pc=await pcPresence(page);await openRepositories(page);
 await expect(page.getByText('Analyzing Synthetic project. Analysis runs on your PC')).toBeVisible();
 await expect(page.getByRole('status').filter({hasText:offline})).toBeVisible();
 await expect(page.getByText(/^Checked /u)).toHaveCount(0);const before=pc.reads();
 await page.getByRole('button',{name:'Refresh connection',exact:true}).click();
 await expect(page.getByText(/^Checked .+\.$/u)).toBeVisible();expect(pc.reads()).toBeGreaterThan(before);
});

test('an unhandled controlroom link explains how to set up the PC app and clears once the PC connects',async({page})=>{
 const pc=await pcPresence(page);await openRepositories(page);
 await page.getByRole('link',{name:'Open Control Room on this PC',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'Starting Control Room on your PC…'})).toBeVisible();
 const help=page.getByRole('alert').filter({hasText:'Your PC has not connected.'});
 await expect(help).toBeVisible();await expect(page.getByRole('status').filter({hasText:'Starting Control Room on your PC…'})).toHaveCount(0);
 await expect(help.getByRole('link',{name:'Download the PC app',exact:true})).toHaveAttribute('href','/control-room-companion.zip');
 await expect(help).toContainText('install-personal-companion.ps1');
 pc.connect();
 await expect(page.getByRole('status').filter({hasText:'Your PC is connected.'})).toBeVisible();
 await expect(help).toHaveCount(0);await expect(page.getByRole('link',{name:'Open Control Room on this PC',exact:true})).toHaveCount(0);
});

test('a handled controlroom link waits for the PC instead of showing setup help',async({page})=>{
 const pc=await pcPresence(page);await openRepositories(page);
 await page.getByRole('link',{name:'Open Control Room on this PC',exact:true}).click();
 // A registered handler moves focus to the browser prompt or the launched app.
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 const waiting=page.getByRole('status').filter({hasText:'Starting Control Room on your PC…'});
 await page.waitForTimeout(5000);
 await expect(waiting).toBeVisible();await expect(page.getByRole('alert').filter({hasText:'Your PC has not connected.'})).toHaveCount(0);
 pc.connect();
 await expect(page.getByRole('status').filter({hasText:'Your PC is connected.'})).toBeVisible();await expect(waiting).toHaveCount(0);
});
