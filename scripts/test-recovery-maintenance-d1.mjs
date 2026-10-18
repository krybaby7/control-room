// Actual isolated Miniflare D1 maintenance proof. No live DB/R2/site binding is used.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {runRecoveryMaintenanceFixture} from '../tests/helpers/recovery-maintenance.ts';
assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node24 required.');
const mf=new Miniflare({modules:true,script:'export default{fetch(){return new Response("isolated maintenance fixture")}}',compatibilityDate:'2026-05-15',d1Databases:['SOURCE','TARGET'],d1Persist:false,cf:false});
try{
 const source=await mf.getD1Database('SOURCE'),target=await mf.getD1Database('TARGET');
 const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
 for(const db of [source,target])for(const name of migrations){const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const statement of sql.split('--> statement-breakpoint'))if(statement.trim())await db.prepare(statement.trim()).run();}
 const result=await runRecoveryMaintenanceFixture(source,target);
 console.log(JSON.stringify({environment:'actual-isolated-Miniflare-D1',migrations:migrations.length,tables:result.tables,guards:result.guards,sourceFreeze:'actual-DB-receipt',target:'paused-manual-only',privateSha256:result.privateSha256,inventorySha256:result.inventorySha256,hostedCutover:false}));
 console.log('PASS actual isolated D1 recovery maintenance: global triggers, source freeze, private root, REPLACE refusal, bounded target batches, rollback, verifier CAS, retained fences/receipts, epoch barrier and manual-only marker.');
}finally{await mf.dispose();}
