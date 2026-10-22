/** Small display helpers for the mission-control dashboard. Pure and timezone-aware (Cairo). */
const MINUTE=60_000,HOUR=3_600_000,DAY=86_400_000;
function instant(value:string|null|undefined):number|null{if(!value)return null;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;}
/** "just now", "4 min ago", "2 h ago", "yesterday", "5 d ago" or an absolute date for older stamps. Future stamps read as "ahead of clock". */
export function relativeTime(value:string|null|undefined,now:string):string{
 const at=instant(value),reference=instant(now);
 if(at===null||reference===null)return 'unknown time';
 const delta=reference-at;
 if(delta< -MINUTE)return 'ahead of clock';
 if(delta<45_000)return 'just now';
 if(delta<HOUR)return `${Math.max(1,Math.round(delta/MINUTE))} min ago`;
 if(delta<DAY)return `${Math.round(delta/HOUR)} h ago`;
 if(delta<2*DAY)return 'yesterday';
 if(delta<14*DAY)return `${Math.round(delta/DAY)} d ago`;
 return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',timeZone:'Africa/Cairo'}).format(new Date(at));
}
/** Cairo clock time for a stamp, e.g. "14:07". */
export function clockLabel(value:string|null|undefined):string{
 const at=instant(value);if(at===null)return '--:--';
 return new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Africa/Cairo'}).format(new Date(at));
}
/** 12400 → "12.4k", 1_250_000 → "1.25M", null → "—". */
export function compactNumber(value:number|null|undefined):string{
 if(value===null||value===undefined||!Number.isFinite(value))return '—';
 const abs=Math.abs(value);
 if(abs<1000)return String(Math.round(value));
 if(abs<100_000)return `${(value/1000).toFixed(1).replace(/\.0$/,'')}k`;
 if(abs<1_000_000)return `${Math.round(value/1000)}k`;
 return `${(value/1_000_000).toFixed(2).replace(/\.?0+$/,'')}M`;
}
/** 75 → "1m 15s", 3600 → "1h 0m", null → "—". */
export function durationLabel(seconds:number|null|undefined):string{
 if(seconds===null||seconds===undefined||!Number.isFinite(seconds)||seconds<0)return '—';
 const whole=Math.floor(seconds);
 if(whole<60)return `${whole}s`;
 if(whole<3600)return `${Math.floor(whole/60)}m ${whole%60}s`;
 return `${Math.floor(whole/3600)}h ${Math.floor((whole%3600)/60)}m`;
}
/** Seconds between two stamps, never negative; null when either stamp is missing or invalid. */
export function secondsBetween(from:string|null|undefined,to:string|null|undefined):number|null{
 const start=instant(from),end=instant(to);if(start===null||end===null)return null;return Math.max(0,(end-start)/1000);
}
export function percent(done:number,total:number):number{
 if(!Number.isFinite(done)||!Number.isFinite(total)||total<=0)return 0;
 return Math.max(0,Math.min(100,Math.round(done/total*100)));
}
/** Clip prose to a sentence-friendly excerpt for a card. */
export function excerpt(text:string|null|undefined,limit=180):string{
 if(!text)return '';
 const clean=text.replace(/\s+/g,' ').trim();
 if(clean.length<=limit)return clean;
 const cut=clean.slice(0,limit);const space=cut.lastIndexOf(' ');
 return `${(space>limit*0.6?cut.slice(0,space):cut).replace(/[,;:\-–]$/,'')}…`;
}
