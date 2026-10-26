/** The first workspace read starts while the page's code is still downloading, so the first
 * render does not wait one more network round trip after hydration. The page's HTML starts it;
 * the first read takes it at most once and only while fresh. Every later read, and any page
 * whose early read is missing, goes to the network as before. */
export const BOOT_READ_GLOBAL='__controlRoomBootRead';
export const BOOT_READ_MAX_AGE_MS=10_000;
export const BOOT_READ_SCRIPT=`(function(){try{var r=fetch('/api/workspace',{credentials:'same-origin',cache:'no-store'});r.catch(function(){});window.${BOOT_READ_GLOBAL}={startedAt:performance.now(),response:r};}catch(e){}})();`;
export function takeBootWorkspaceRead(now:()=>number=()=>performance.now()):Promise<Response>|null{
 if(typeof window==='undefined')return null;
 const holder=window as unknown as Record<string,unknown>,value=holder[BOOT_READ_GLOBAL] as {startedAt?:unknown;response?:unknown}|undefined;
 delete holder[BOOT_READ_GLOBAL];
 if(!value||typeof value.startedAt!=='number'||!(value.response instanceof Promise))return null;
 return now()-value.startedAt<=BOOT_READ_MAX_AGE_MS?value.response as Promise<Response>:null;
}
