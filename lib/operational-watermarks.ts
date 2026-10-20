import type {SqlDatabase} from './workspace-store.ts';
const moduleStreams=[
 ["source_observations","sources","source_observations_sequence"],
 ["source_sync_runs","sources","source_sync_runs_sequence"],
 ["integration_history","sources","integration_history_sequence"],
 ["review_snapshots","reviews","review_snapshots_sequence"],
 ["review_analysis_runs","reviews","review_analysis_runs_sequence"],
 ["notification_events","notifications","notification_events_sequence"],
 ["automation_occurrences","automations","automation_occurrences_sequence"],
 ["agent_results","agents","agent_results_sequence"],
 ["evaluation_runs","agents","evaluation_runs_sequence"]
]as const;
const ownerColumn='(SELECT user_id FROM watermark_owner)';
const watermarkSql="WITH watermark_owner AS MATERIALIZED(SELECT ? user_id),selected_heads AS MATERIALIZED(SELECT stream_id,last_sequence FROM operational_stream_heads WHERE user_id="+ownerColumn+" ORDER BY stream_id LIMIT 201) SELECT (SELECT json_group_array(json_object('stream_id',stream_id,'last_sequence',last_sequence)) FROM selected_heads) heads_json,"+moduleStreams.map(([table,,field])=>"(SELECT MAX(stream_sequence) FROM "+table+" WHERE user_id="+ownerColumn+") "+field).join(',')+",(SELECT MAX(stream_sequence) FROM audit_events WHERE user_id="+ownerColumn+" AND stream_id='sources') source_audit_sequence,(SELECT MAX(stream_sequence) FROM audit_events WHERE user_id="+ownerColumn+" AND stream_id='agents') agent_audit_sequence";
/** One owner-bound statement freezes heads and all row/audit maxima together.
 * No owner data, schema assumption or authority is cached between calls. */
export async function readOperationalWatermarks(db:SqlDatabase,userId:string):Promise<Record<string,number>>{
 if(!userId)throw new Error('An authenticated owner is required.');
 const snapshot=await db.prepare(watermarkSql).bind(userId).first<Record<string,unknown>>();
 if(!snapshot||typeof snapshot.heads_json!=='string'||snapshot.heads_json.length>65536)throw new Error('Invalid operational stream watermark.');
 const expected=['heads_json',...moduleStreams.map(([, ,field])=>field),'source_audit_sequence','agent_audit_sequence'];
 if(Object.keys(snapshot).length!==expected.length||expected.some(field=>!Object.hasOwn(snapshot,field)))throw new Error('Invalid operational stream watermark.');
 let rows:unknown;try{rows=JSON.parse(snapshot.heads_json);}catch{throw new Error('Invalid operational stream watermark.');}
 if(!Array.isArray(rows))throw new Error('Invalid operational stream watermark.');
 if(rows.length>200)throw new Error('Operational stream bound exceeded.');
 const result:Record<string,number>={sources:0};
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==2||typeof row.stream_id!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(row.stream_id)||!Number.isSafeInteger(row.last_sequence)||row.last_sequence<0)throw new Error('Invalid operational stream watermark.');
  result[row.stream_id]=row.last_sequence;
 }
 for(const [,stream,field]of moduleStreams){
  const sequence=snapshot[field];if(sequence!==null&&sequence!==undefined&&(!Number.isSafeInteger(sequence)||(sequence as number)<0||(sequence as number)>(result[stream]??0)))throw new Error(stream==='sources'?'Source rows exceed their committed operational watermark.':'Review rows exceed their committed operational watermark.');
 }
 const audit=snapshot.source_audit_sequence;if(audit!==null&&audit!==undefined&&(audit as number)>result.sources)throw new Error('Operational audit exceeds its committed source watermark.');
 const agentAudit=snapshot.agent_audit_sequence;if(agentAudit!==null&&agentAudit!==undefined&&(agentAudit as number)>(result.agents??0))throw new Error('Agent audit exceeds its committed operational watermark.');
 return result;
}
export function validateOperationalWatermarks(value:unknown):asserts value is Record<string,number>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length>200)throw new Error('Invalid operational watermarks.');
 for(const [key,sequence]of Object.entries(value))if(!/^[a-z][a-z0-9_-]{0,63}$/.test(key)||typeof sequence!=='number'||!Number.isSafeInteger(sequence)||sequence<0)throw new Error('Invalid operational watermark.');
}
