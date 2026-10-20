import {test,expect,type Page,type APIResponse,type Route} from '@playwright/test';
import type {CapturedServerResponse} from '../e2e/server-response';
import {fixtureOrigin,openFixture,setFixtureSession,workspace} from '../e2e/helpers';
import type {EvidenceSnapshot} from '../../lib/evidence-store';
import type {WorkspaceCommand} from '../../lib/workspace-protocol';
import type {ArchiveStageSummary} from '../../lib/attachment-archive-recovery';
async function snapshot(page:Page):Promise<EvidenceSnapshot>{const response=await page.request.get('/api/evidence');expect(response.ok()).toBeTruthy();return response.json();}
async function command(page:Page,command:WorkspaceCommand){const before=await workspace(page),issued=await page.request.post('/api/workspace/mutation-ids',{headers:{Origin:fixtureOrigin},data:{}});expect(issued.ok()).toBeTruthy();const mutationId=(await issued.json()).mutationId,response=await page.request.post('/api/workspace',{headers:{Origin:fixtureOrigin},data:{revision:before.revision,mutationId,command}});expect(response.ok(),await response.text()).toBeTruthy();const receipt=await page.request.get(`/api/workspace/mutations/${mutationId}`);expect(receipt.ok()).toBeTruthy();expect(await receipt.json()).toMatchObject({status:'committed',receipt:{mutationId}});}
async function stages(page:Page):Promise<ArchiveStageSummary[]>{const result:ArchiveStageSummary[]=[];let after:string|null=null;do{const response:APIResponse=await page.request.get(`/api/workspace/imports/archives${after?`?after=${after}`:''}`);expect(response.ok(),await response.text()).toBeTruthy();const data:{stages:ArchiveStageSummary[];nextAfter:string|null}=await response.json();result.push(...data.stages);after=data.nextAfter;}while(after);return result;}
interface Staged {id:string;hash:string;archive:{id:string;files:number;bytes:number;expiresAt:string;sourceManifestHash:string}}
/** Capture the real discard response before allowing the UI to navigate.
 * The request is sent once, with its original method, URL, and body; its
 * original status, headers, and copied bytes are fulfilled unchanged.
 */
async function captureDiscardResponse(page:Page,stageId:string,action:()=>Promise<void>):Promise<CapturedServerResponse>{
 let resolve!:(value:CapturedServerResponse)=>void,reject!:(error:unknown)=>void;
 const captured=new Promise<CapturedServerResponse>((yes,no)=>{resolve=yes;reject=no;});
 const matches=(url:URL)=>url.pathname==='/api/workspace/imports/archives'&&url.searchParams.get('id')===stageId;
 let claimed=false;
 const handler=async(route:Route)=>{
  if(route.request().method()!=='DELETE'||claimed){await route.continue();return;}claimed=true;
  try{
   const response=await route.fetch({maxRedirects:0,maxRetries:0});
   try{
    const body=await response.body(),result={status:response.status(),ok:response.ok(),headers:response.headers(),body:Buffer.from(body),submitted:null};
    await route.fulfill({status:result.status,headers:result.headers,body});resolve(result);
   }finally{await response.dispose();}
  }catch(error){reject(error);await route.abort('failed').catch(()=>{});}
 };
 await page.route(matches,handler);
 try{const [,response]=await Promise.all([action(),captured]);return response;}
 finally{await page.unroute(matches,handler);}
}

test('lost native archive response is recovered by explicit review and discarded without deleting retained bytes',async({page})=>{
 await openFixture(page);const unique=crypto.randomUUID(),filename=`synthetic-lost-archive-${unique}.txt`,bytes=Buffer.from(`Synthetic archive response loss ${unique}\nLocal emulator only.\n`);
 await command(page,{type:'attachment.reserve',value:{filename,mimeType:'text/plain',expectedBytes:bytes.length}});const reserved=(await snapshot(page)).attachments.find(row=>row.filename===filename)!;expect(reserved.status).toBe('reserved');const path=`/api/attachments/${reserved.id}/content`;
 const uploaded=await page.request.put(path,{headers:{Origin:fixtureOrigin,'Content-Type':'text/plain'},data:bytes});expect(uploaded.ok(),await uploaded.text()).toBeTruthy();expect(await uploaded.json()).toMatchObject({id:reserved.id,status:'staged',finalized:false});await command(page,{type:'attachment.finalize',id:reserved.id});const original=(await snapshot(page)).attachments.find(row=>row.id===reserved.id)!;expect(original.status).toBe('ready');
 const before=await workspace(page),beforeEvidence=await snapshot(page),exported=await page.request.get('/api/workspace/export/archive');expect(exported.ok(),await exported.text()).toBeTruthy();expect(exported.headers()['content-type']).toBe('application/zip');const zip=await exported.body();expect(zip.subarray(0,4)).toEqual(Buffer.from([0x50,0x4b,0x03,0x04]));
 let posts=0,processed=0;let resolveStage!:(value:Staged)=>void,rejectStage!:(reason:unknown)=>void;const captured=new Promise<Staged>((resolve,reject)=>{resolveStage=resolve;rejectStage=reject;});
 await page.route('**/api/workspace/imports/archive',async route=>{
  if(route.request().method()!=='POST'){await route.continue();return;}posts++;
  if(posts!==1){await route.continue();return;}
  try{const response=await route.fetch({maxRedirects:0,maxRetries:0});try{const body=Buffer.from(await response.body());expect(response.ok(),body.toString('utf8')).toBeTruthy();const value=JSON.parse(body.toString('utf8')) as Staged;processed++;resolveStage(value);}finally{await response.dispose();}await route.abort('connectionreset');}catch(error){rejectStage(error);await route.abort('failed').catch(()=>{});}
 });
 await page.reload();await page.getByRole('button',{name:'Sources',exact:true}).click();await page.getByLabel('Choose file for import review',{exact:true}).setInputFiles({name:`synthetic-lost-${unique}.zip`,mimeType:'application/zip',buffer:zip});const staged=await captured;expect(staged.archive.id).toMatch(/^[a-f0-9-]{36}$/);expect(processed).toBe(1);
 await expect(page.getByText('If the archive response was lost, a private stage may remain until expiry.',{exact:false})).toBeVisible();await expect(page.getByRole('heading',{name:'Native archive staged for explicit replacement review',exact:true})).not.toBeVisible();expect(posts).toBe(1);expect(await workspace(page)).toEqual(before);
 const stageAfterLoss=(await stages(page)).find(row=>row.id===staged.archive.id)!;expect(stageAfterLoss).toMatchObject({status:'verified',recoverableStagedImport:{id:staged.id,hash:staged.hash},physicalCharged:{files:staged.archive.files,bytes:staged.archive.bytes},pendingUploadCount:0});expect(stageAfterLoss).not.toHaveProperty('namespace');expect(stageAfterLoss).not.toHaveProperty('storageKey');expect(stageAfterLoss).not.toHaveProperty('ownerId');const charged=(await snapshot(page)).physicalAttachmentUsage!;expect(charged.files).toBe(beforeEvidence.physicalAttachmentUsage!.files+staged.archive.files);expect(charged.bytes).toBe(beforeEvidence.physicalAttachmentUsage!.bytes+staged.archive.bytes);
 await page.reload();await page.getByRole('button',{name:'Sources',exact:true}).click();const recovery=page.getByRole('region',{name:'Recoverable archive stages',exact:true});await recovery.getByRole('button',{name:'Refresh recoverable archives',exact:true}).click();await expect(recovery.getByText(/^Page 1 ·/)).toBeVisible();let pageNumber=1;
 let article=recovery.locator('article').filter({has:page.getByRole('heading',{name:`Archive ${staged.archive.id}`,exact:true})});while(await article.count()===0){const next=recovery.getByRole('button',{name:'Next 50 stages',exact:true});await expect(next).toBeEnabled();const response=page.waitForResponse(value=>value.request().method()==='GET'&&new URL(value.url()).pathname==='/api/workspace/imports/archives');await next.click();await response;pageNumber++;await expect(recovery.getByText(new RegExp(`^Page ${pageNumber} ·`))).toBeVisible();article=recovery.locator('article').filter({has:page.getByRole('heading',{name:`Archive ${staged.archive.id}`,exact:true})});}
 await expect(article).toContainText('verified');await expect(article).toContainText(`Physical charge: ${staged.archive.files} files`);await article.getByRole('button',{name:'Open existing import review',exact:true}).click();await expect(page.getByRole('heading',{name:'Recovered native archive stage',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Native archive staged for explicit replacement review',exact:true})).toBeVisible();await expect(page.getByLabel('Import mode',{exact:true})).toHaveValue('replace');await expect(page.getByRole('checkbox',{name:'I reviewed the full replacement and its recovery snapshot requirement.',exact:true})).not.toBeChecked();await expect(page.getByRole('button',{name:'Replace entire workspace with reviewed file',exact:true})).toBeDisabled();expect(await workspace(page)).toEqual(before);expect(posts).toBe(1);expect(processed).toBe(1);
 const discarded=await captureDiscardResponse(page,staged.archive.id,()=>page.getByRole('button',{name:'Discard staged file',exact:true}).click());expect(discarded.ok,discarded.body.toString('utf8')).toBeTruthy();expect(JSON.parse(discarded.body.toString('utf8'))).toEqual({discarded:true,physicalDeletion:false});await expect(page.getByText('Archive review was discarded. Staged physical copies remain charged until guarded cleanup confirms deletion. Your workspace has not changed.',{exact:true})).toBeVisible();
 const failed=(await stages(page)).find(row=>row.id===staged.archive.id)!;expect(failed.status).toBe('failed');expect(failed.recoverableStagedImport).toBeUndefined();expect(failed.physicalCharged).toEqual(stageAfterLoss.physicalCharged);expect(failed.pendingUploadCount).toBe(0);expect((await snapshot(page)).physicalAttachmentUsage).toEqual(charged);expect((await page.request.get(`/api/workspace/imports/${staged.id}`)).status()).toBe(409);expect(await workspace(page)).toEqual(before);expect((await snapshot(page)).attachments.find(row=>row.id===original.id)).toEqual(original);const downloaded=await page.request.get(path);expect(downloaded.ok()).toBeTruthy();const downloadedBytes=Buffer.from(await downloaded.body());expect(downloadedBytes).toEqual(bytes);expect(Buffer.from(await crypto.subtle.digest('SHA-256',new Uint8Array(downloadedBytes))).toString('hex')).toBe(original.sha256);expect(posts).toBe(1);
 await setFixtureSession(page,'b');expect((await stages(page)).some(row=>row.id===staged.archive.id)).toBe(false);expect((await page.request.get(`/api/workspace/imports/${staged.id}`)).status()).toBe(409);expect((await page.request.get(path)).status()).toBe(404);
});
