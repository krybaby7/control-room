import { SessionExpiredError } from './workspace-client.ts';
export interface PollingDependencies<T extends {revision:number}> {
 read:()=>Promise<T>;
 accept:(value:T)=>void;
 onExpire:()=>void;
 onError?:(error:unknown)=>void;
 now?:()=>number;
 setTimer?:(callback:()=>void,delayMs:number)=>unknown;
 clearTimer?:(handle:unknown)=>void;
 random?:()=>number;
 visible?:boolean;
 signedIn?:boolean;
 busy?:boolean;
 initialRevision?:number;
}
/** Transport-independent refresh coordinator. The injected read must have a bounded deadline. */
export class WorkspacePolling<T extends {revision:number}> {
 private readonly deps:PollingDependencies<T>;
 private running=false;
 private disposed=false;
 private visible:boolean;
 private signedIn:boolean;
 private busy:boolean;
 private pending=false;
 private generation=0;
 private inFlight:Promise<void>|null=null;
 private flightGeneration=0;
 private timer:unknown=null;
 private failures=0;
 private lastRevision:number;
 private lastRefreshedAt:number|null=null;
 constructor(deps:PollingDependencies<T>) {
  this.deps=deps;this.visible=deps.visible??true;this.signedIn=deps.signedIn??true;this.busy=deps.busy??false;
  this.lastRevision=deps.initialRevision??0;
  if(!Number.isSafeInteger(this.lastRevision)||this.lastRevision<0)throw new Error('Invalid initial polling revision.');
 }
 snapshot(){return {running:this.running,visible:this.visible,signedIn:this.signedIn,busy:this.busy,pending:this.pending,inFlight:this.inFlight!==null,failures:this.failures,lastRevision:this.lastRevision,lastRefreshedAt:this.lastRefreshedAt};}
 private eligible(){return this.running&&!this.disposed&&this.visible&&this.signedIn&&!this.busy;}
 private clear(){if(this.timer!==null){(this.deps.clearTimer??(handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);this.timer=null;}}
 private schedule(){
  this.clear();if(!this.eligible()||this.inFlight)return;
  const base=this.failures===0?30_000:[30_000,60_000,120_000,300_000][Math.min(this.failures-1,3)];
  const random=Math.min(1,Math.max(0,(this.deps.random??Math.random)()));
  const delay=Math.round(base*(0.9+random*0.2));
  this.timer=(this.deps.setTimer??((callback,ms)=>setTimeout(callback,ms)))(()=>{this.timer=null;void this.refresh();},delay);
 }
 start(){if(this.disposed)return;this.running=true;void this.refresh();}
 stop(){this.running=false;this.pending=false;this.generation++;this.clear();}
 dispose(){this.stop();this.disposed=true;}
 observeRevision(revision:number){if(!Number.isSafeInteger(revision)||revision<0)throw new Error('Invalid polling revision.');this.lastRevision=Math.max(this.lastRevision,revision);}
 setVisible(visible:boolean){const changed=this.visible!==visible;this.visible=visible;if(!visible)this.clear();else if(changed)void this.refresh();}
 setSignedIn(signedIn:boolean){
  const changed=this.signedIn!==signedIn;this.signedIn=signedIn;
  if(!signedIn){this.generation++;this.pending=false;this.failures=0;this.lastRefreshedAt=null;this.lastRevision=0;this.clear();}
  else if(changed)void this.refresh();
 }
 setBusy(busy:boolean){const changed=this.busy!==busy;this.busy=busy;if(busy)this.clear();else if(changed){if(this.pending)void this.refresh();else this.schedule();}}
 focus(){return this.refresh();}
 online(){return this.refresh();}
 manual(){return this.refresh();}
 refresh():Promise<void> {
  if(!this.running||this.disposed||!this.signedIn||!this.visible)return Promise.resolve();
  if(this.busy){this.pending=true;return this.inFlight??Promise.resolve();}
  // A focus event joins the existing read; it never starts a parallel GET.
  if(this.inFlight){if(this.flightGeneration!==this.generation)this.pending=true;return this.inFlight;}
  this.clear();this.pending=false;
  const generation=this.generation;this.flightGeneration=generation;
  const flight=Promise.resolve().then(()=>this.deps.read()).then(value=>{
   if(generation!==this.generation||!this.running||!this.signedIn||this.disposed)return;
   if(this.busy){this.pending=true;return;}
   if(!Number.isSafeInteger(value.revision)||value.revision<1)throw new Error('Invalid polling response revision.');
   this.failures=0;this.lastRefreshedAt=(this.deps.now??Date.now)();
   if(value.revision>=this.lastRevision){this.lastRevision=value.revision;this.deps.accept(value);}
  }).catch(error=>{
   if(generation!==this.generation||!this.running||!this.signedIn||this.disposed)return;
   if(error instanceof SessionExpiredError){this.setSignedIn(false);this.deps.onExpire();return;}
   if(this.busy){this.pending=true;return;}
   this.failures++;this.deps.onError?.(error);
  }).finally(()=>{
   this.inFlight=null;
   if(this.pending&&this.eligible()){this.pending=false;void this.refresh();}else this.schedule();
  });
  this.inFlight=flight;return flight;
 }
}
