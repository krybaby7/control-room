import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cairoDate,currentWeek} from '../lib/calendar.ts';
import {clockLabel,relativeTime} from '../lib/dashboard/format.ts';
test('Cairo cached formatting configuration preserves spring skipped midnight and autumn repeated hour',()=>{
 assert.equal(cairoDate('2026-04-23T21:59:59Z'),'2026-04-23');assert.equal(clockLabel('2026-04-23T21:59:59Z'),'23:59');assert.equal(cairoDate('2026-04-23T22:00:00Z'),'2026-04-24');assert.equal(clockLabel('2026-04-23T22:00:00Z'),'01:00');
 assert.equal(cairoDate('2026-10-29T20:59:59Z'),'2026-10-29');assert.equal(clockLabel('2026-10-29T20:59:59Z'),'23:59');assert.equal(cairoDate('2026-10-29T21:00:00Z'),'2026-10-29');assert.equal(clockLabel('2026-10-29T21:00:00Z'),'23:00');assert.equal(cairoDate('2026-10-29T22:00:00Z'),'2026-10-30');assert.equal(clockLabel('2026-10-29T22:00:00Z'),'00:00');
});
test('different calls retain current dates and weeks rather than cached owner/date output',()=>{
 assert.equal(currentWeek('2026-11-01T21:59:59Z'),'2026-10-26');assert.equal(currentWeek('2026-11-01T22:00:00Z'),'2026-11-02');assert.equal(cairoDate('2026-04-24'),'2026-04-24');assert.equal(relativeTime('2026-04-23T22:15:00Z','2026-06-01T00:00:00Z'),'24 Apr');assert.equal(relativeTime('2026-10-29T22:15:00Z','2026-12-01T00:00:00Z'),'30 Oct');assert.equal(clockLabel(null),'--:--');assert.throws(()=>cairoDate('not a date'),/Invalid/);
});
function luminance(hex:string){const channels=hex.match(/../gu)!.map(value=>parseInt(value,16)/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;}
test('ordinary mission-control briefing hint text meets 4.5:1 on its actual surface',async()=>{const css=await readFile(new URL('../app/globals.css',import.meta.url),'utf8'),hint=css.match(/\.mc-brief-hint,\.mc-brief-notice\{([^}]+)\}/u)?.[1],surface=css.match(/\.mc-brief\{([^}]+)\}/u)?.[1];assert.ok(hint);assert.ok(surface);const foreground=hint.match(/(?:^|;)color:#([a-f\d]{6})(?:;|$)/iu)?.[1],background=surface.match(/(?:^|;)background:#([a-f\d]{6})(?:;|$)/iu)?.[1];assert.ok(foreground);assert.ok(background);const a=luminance(foreground),b=luminance(background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);assert.ok(ratio>=4.5,`Actual briefing hint contrast ${ratio.toFixed(2)}:1 is below ordinary-text minimum.`);});
