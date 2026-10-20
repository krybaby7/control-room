import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,readdirSync,statSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {BRIDGE_LIMITS,canonicalJson,exactObject,opaqueId,timestamp} from './config.mjs';

const MAX_ENTRY_BYTES=262144;
const METRIC_KEYS=['cpuPercent','memoryPercent','gpuUtilizationPercent','gpuMemoryUsedBytes','gpuMemoryTotalBytes','gpuTemperatureC','diskReadBytesPerSec','diskWriteBytesPerSec','networkSentBytesPerSec','networkReceivedBytesPerSec'];
function validateHeartbeat(bytes){
 if(typeof bytes!=='string'||Buffer.byteLength(bytes)>MAX_ENTRY_BYTES)throw new Error('Heartbeat exceeds bound');
 const value=JSON.parse(bytes);exactObject(value,['schemaVersion','deviceId','bootId','generation','sequence','sentAt','bridgeVersion','observations']);
 if(value.schemaVersion!==1)throw new Error('Unsupported heartbeat');
 opaqueId(value.deviceId);if(typeof value.bootId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.bootId))throw new Error('Invalid boot');
 for(const key of ['generation','sequence'])if(!Number.isSafeInteger(value[key])||value[key]<1)throw new Error('Invalid monotonic identity');
 timestamp(value.sentAt);if(typeof value.bridgeVersion!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.bridgeVersion))throw new Error('Invalid version');
 if(!Array.isArray(value.observations)||value.observations.length>8)throw new Error('Observation bound exceeded');
 const identities=new Set();
 for(const observation of value.observations){
  exactObject(observation,['source','instanceId','observedAt','reportedAgeSeconds','state','diagnostic','metrics',...(Object.hasOwn(observation,'selectedGpuAlias')?['selectedGpuAlias']:[])]);
  if(Object.hasOwn(observation,'selectedGpuAlias')&&observation.selectedGpuAlias!==null){opaqueId(observation.selectedGpuAlias);if(observation.selectedGpuAlias.length>64)throw new Error('GPU alias exceeds bound');}
  if(!['pc-command-center','agent-lab','trade-graph'].includes(observation.source))throw new Error('Unsupported observation');
  opaqueId(observation.instanceId);const identity=observation.source+':'+observation.instanceId;if(identities.has(identity))throw new Error('Duplicate observation');identities.add(identity);
  if(observation.observedAt!==null)timestamp(observation.observedAt);
  if(observation.reportedAgeSeconds!==null&&(typeof observation.reportedAgeSeconds!=='number'||!Number.isFinite(observation.reportedAgeSeconds)||observation.reportedAgeSeconds<0||observation.reportedAgeSeconds>604800))throw new Error('Invalid source age');
  if(!['ready','warming','degraded','unavailable','disabled'].includes(observation.state)||!['ok','source_unreachable','source_stale','source_invalid','not_configured'].includes(observation.diagnostic))throw new Error('Invalid observation state');
  if(observation.metrics!==null){exactObject(observation.metrics,METRIC_KEYS);for(const key of METRIC_KEYS){const number=observation.metrics[key];if(number===null)continue;const min=key==='gpuTemperatureC'?-50:0,max=key.endsWith('Percent')?100:key==='gpuTemperatureC'?150:Number.MAX_SAFE_INTEGER;if(typeof number!=='number'||!Number.isFinite(number)||number<min||number>max||(key.endsWith('Bytes')&&!Number.isSafeInteger(number)))throw new Error('Invalid metric');}}
 }
 if(canonicalJson(value)!==bytes)throw new Error('Heartbeat must use canonical JSON');
 return value;
}
const digest=value=>createHash('sha256').update(value).digest('hex');

/**
 * Lossy telemetry only. Delivery classification is outside the immutable heartbeat.
 * Reopening never promotes retained payloads to live. A newly enqueued live sample
 * must receive a live server receipt before history can be offered.
 */
export class Outbox{
 static open(options){return new Outbox(options);}
 constructor({directory}){
  if(typeof directory!=='string'||!isAbsolute(directory))throw new Error('Outbox directory must be absolute');
  mkdirSync(directory,{recursive:true,mode:0o700});this.directory=directory;this.liveId=null;this.historyAllowed=false;this.closed=false;
  // Refuse unknown pre-existing files instead of deleting credentials or journals.
  const allowed=new Set(['outbox.sqlite','outbox.sqlite-journal']);
  if(readdirSync(directory).some(name=>!allowed.has(name)))throw new Error('Outbox directory contains unknown files');
  if(this.physicalBytes()>BRIDGE_LIMITS.outboxBytes)throw new Error('Physical outbox bound exceeded');
  this.db=new DatabaseSync(join(directory,'outbox.sqlite'));
  try{
   this.db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=960; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
   if(this.db.prepare('PRAGMA page_size').get().page_size!==4096||this.db.prepare('PRAGMA page_count').get().page_count>960)throw new Error('Unsupported outbox storage');
   this.db.exec('CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY CHECK(id=1),gap_count INTEGER NOT NULL CHECK(gap_count>=0)); INSERT OR IGNORE INTO metadata VALUES(1,0); CREATE TABLE IF NOT EXISTS telemetry(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,device_id TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,heartbeat_bytes TEXT NOT NULL,bytes INTEGER NOT NULL,live_window_id TEXT,window_expires_at TEXT,created_at TEXT NOT NULL,history_only INTEGER NOT NULL CHECK(history_only IN(0,1)),UNIQUE(device_id,boot_id,sequence));');
   chmodSync(join(directory,'outbox.sqlite'),0o600);
  }catch(error){this.db.close();throw error;}
 }
 physicalBytes(){return readdirSync(this.directory).reduce((total,name)=>total+statSync(join(this.directory,name)).size,0);}
 assertOpen(){if(this.closed)throw new Error('Outbox is closed');}
 transaction(work){this.assertOpen();this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}}
 enqueue({heartbeatBytes,liveWindowId=null,windowExpiresAt=null,createdAt}){
  this.assertOpen();const heartbeat=validateHeartbeat(heartbeatBytes);timestamp(createdAt);
  if((liveWindowId===null)!==(windowExpiresAt===null))throw new Error('Incomplete live window');
  if(liveWindowId!==null){opaqueId(liveWindowId);timestamp(windowExpiresAt);}
  const id=digest(heartbeatBytes),size=Buffer.byteLength(heartbeatBytes);
  const existing=this.db.prepare('SELECT * FROM telemetry WHERE device_id=? AND boot_id=? AND sequence=?').get(heartbeat.deviceId,heartbeat.bootId,heartbeat.sequence);
  if(existing){if(existing.id!==id||existing.heartbeat_bytes!==heartbeatBytes||existing.live_window_id!==liveWindowId||existing.window_expires_at!==windowExpiresAt||existing.created_at!==createdAt)throw new Error('Immutable heartbeat retry mismatch');return {id};}
  // Keep enough free main-db pages for a single maximum-size sample and index
  // growth. DELETE journals can be as large as the bounded main database.
  const result=this.transaction(()=>{
   const repeated=this.db.prepare('SELECT * FROM telemetry WHERE device_id=? AND boot_id=? AND sequence=?').get(heartbeat.deviceId,heartbeat.bootId,heartbeat.sequence);
   if(repeated){if(repeated.id!==id||repeated.heartbeat_bytes!==heartbeatBytes||repeated.live_window_id!==liveWindowId||repeated.window_expires_at!==windowExpiresAt||repeated.created_at!==createdAt)throw new Error('Immutable heartbeat retry mismatch');return {id,inserted:false};}
   const removeOldest=()=>{
    const old=this.db.prepare('SELECT ordinal FROM telemetry ORDER BY ordinal LIMIT 1').get();if(!old)throw new Error('Outbox cannot fit newest telemetry');
    this.db.prepare('DELETE FROM telemetry WHERE ordinal=?').run(old.ordinal);this.db.exec('UPDATE metadata SET gap_count=gap_count+1 WHERE id=1');
   };
   let totals=this.db.prepare('SELECT COUNT(*) records,COALESCE(SUM(bytes),0) bytes FROM telemetry').get();
   while(totals.records>=BRIDGE_LIMITS.outboxRecords||totals.bytes+size>BRIDGE_LIMITS.outboxBytes){removeOldest();totals=this.db.prepare('SELECT COUNT(*) records,COALESCE(SUM(bytes),0) bytes FROM telemetry').get();}
   // Conservative allocated pages minus freelist bounds physical growth before
   // writing. Pages stay allocated and reusable; no VACUUM or full-copy files.
   let used=this.db.prepare('PRAGMA page_count').get().page_count-this.db.prepare('PRAGMA freelist_count').get().freelist_count;
   const required=Math.ceil(size/4096)+12;
   while(used+required>920){removeOldest();used=this.db.prepare('PRAGMA page_count').get().page_count-this.db.prepare('PRAGMA freelist_count').get().freelist_count;}
   this.db.exec('UPDATE telemetry SET history_only=1');
   this.db.prepare('INSERT INTO telemetry(id,device_id,boot_id,sequence,heartbeat_bytes,bytes,live_window_id,window_expires_at,created_at,history_only) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,heartbeat.deviceId,heartbeat.bootId,heartbeat.sequence,heartbeatBytes,size,liveWindowId,windowExpiresAt,createdAt,liveWindowId===null?1:0);
   return {id,inserted:true};
  });
  if(result.inserted){this.liveId=liveWindowId===null?null:id;this.historyAllowed=false;}return {id};
 }
 pending({now,limit=BRIDGE_LIMITS.outboxRecords}){
  this.assertOpen();timestamp(now);if(!Number.isSafeInteger(limit)||limit<1||limit>240)throw new Error('Invalid pending bound');
  if(!this.historyAllowed){
   if(!this.liveId)return [];
   const row=this.db.prepare('SELECT * FROM telemetry WHERE id=? AND history_only=0 AND ordinal=(SELECT MAX(ordinal) FROM telemetry)').get(this.liveId);
   if(!row||Date.parse(row.window_expires_at)<=Date.parse(now))return [];
   return [this.present(row,'live')];
  }
  return this.db.prepare('SELECT * FROM telemetry ORDER BY ordinal LIMIT ?').all(limit).map(row=>this.present(row,'history'));
 }
 present(row,delivery){return {id:row.id,heartbeatBytes:row.heartbeat_bytes,delivery,liveWindowId:row.live_window_id,windowExpiresAt:row.window_expires_at,createdAt:row.created_at};}
 ack(id,{classification}){
  this.assertOpen();if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)||!['live','history'].includes(classification))throw new Error('Invalid acknowledgement');
  const unlock=this.transaction(()=>{
   const row=this.db.prepare('SELECT * FROM telemetry WHERE id=?').get(id);if(!row)return false;
   const newest=this.db.prepare('SELECT MAX(ordinal) ordinal FROM telemetry').get().ordinal;
   this.db.prepare('DELETE FROM telemetry WHERE id=?').run(id);
   return classification==='live'&&id===this.liveId&&row.history_only===0&&row.ordinal===newest;
  });
  if(id===this.liveId){this.liveId=null;this.historyAllowed=unlock;}
 }
 status(){this.assertOpen();const total=this.db.prepare('SELECT COUNT(*) records,COALESCE(SUM(bytes),0) bytes FROM telemetry').get();return {...total,gapCount:this.db.prepare('SELECT gap_count FROM metadata WHERE id=1').get().gap_count};}
 close(){if(!this.closed){this.db.close();this.closed=true;}}
}
