import test from 'node:test';
import assert from 'node:assert/strict';
import {filterEvidenceDates,filterDecisionReviews,decisionReviewState,reviewAsOfDate,REVIEW_BROWSE_LIMIT} from '../lib/review-browse.ts';
const evidence=[
 {id:'same',version:1,observedAt:'2024-02-28T22:30:00.000Z',recordedAt:'2024-03-01T10:00:00.000Z'},
 {id:'same',version:2,observedAt:null,recordedAt:'2024-03-02T10:00:00.000Z'},
 {id:'future',version:1,observedAt:'2024-03-04T10:00:00.000Z',recordedAt:'2024-03-05T10:00:00.000Z'},
];
test('inclusive evidence range uses Cairo calendar days for immutable current and historical versions',()=>{
 const original=structuredClone(evidence);assert.deepEqual(filterEvidenceDates(evidence,{field:'observedAt',from:'2024-02-29',through:'2024-02-29'}),[evidence[0]]);
 assert.deepEqual(filterEvidenceDates(evidence,{field:'recordedAt',from:'2024-03-01',through:'2024-03-02'}),evidence.slice(0,2));
 assert.deepEqual(filterEvidenceDates(evidence,{field:'observedAt',from:'2024-03-04'}),[evidence[2]]);assert.deepEqual(filterEvidenceDates(evidence,{field:'observedAt',through:'2024-02-29'}),[evidence[0]]);assert.deepEqual(evidence,original);
});
test('unknown dates stay unknown and are excluded only from an active range unless explicitly included',()=>{
 assert.deepEqual(filterEvidenceDates(evidence,{field:'observedAt'}),evidence);
 assert.deepEqual(filterEvidenceDates(evidence,{field:'observedAt',from:'2024-02-29',through:'2024-02-29',includeUnknown:true}),evidence.slice(0,2));
 assert.deepEqual(filterEvidenceDates(evidence,{field:'recordedAt',from:'2024-03-02',through:'2024-03-02',includeUnknown:true}),[evidence[1]]);
});
test('strict date filters reject non-calendar and reversed ranges, unknown fields and malformed version dates',()=>{
 for(const from of ['2023-02-29','2024-02-30','2024-13-01','2024-00-01','2024-01-00','2024-2-01',' 2024-02-29','2024-02-29T00:00:00Z'])assert.throws(()=>filterEvidenceDates(evidence,{field:'observedAt',from}));
 assert.throws(()=>filterEvidenceDates(evidence,{field:'observedAt',from:'2024-03-02',through:'2024-03-01'}));
 // @ts-expect-error strict runtime decoding rejects unknown filter authority
 assert.throws(()=>filterEvidenceDates(evidence,{field:'observedAt',includeUnknown:true,accept:true}));
 for(const observedAt of ['2024-02-30T00:00:00Z','not-a-date','2024-02-29'])assert.throws(()=>filterEvidenceDates([{...evidence[0],observedAt}],{field:'observedAt'}));
});
test('decision due filter includes today and overdue dates, excludes future dates and labels null unknown',()=>{
 const rows=[{id:'decision',version:1,reviewOn:'2024-02-28'},{id:'decision',version:2,reviewOn:'2024-02-29'},{id:'later',version:1,reviewOn:'2024-03-01'},{id:'unknown',version:1,reviewOn:null}],asOf='2024-02-28T22:30:00Z';
 assert.equal(reviewAsOfDate(asOf),'2024-02-29');assert.deepEqual(filterDecisionReviews(rows,{mode:'due',asOf}),rows.slice(0,2));assert.deepEqual(filterDecisionReviews(rows,{mode:'not-due',asOf}),[rows[2]]);assert.deepEqual(filterDecisionReviews(rows,{mode:'unknown',asOf}),[rows[3]]);assert.deepEqual(filterDecisionReviews(rows,{mode:'all',asOf}),rows);assert.equal(decisionReviewState(null,asOf),'unknown');assert.equal(decisionReviewState('2024-03-01',asOf),'not-due');
});
test('Cairo as-of conversion follows winter and summer offsets and rejects invalid calendar timestamps',()=>{
 assert.equal(reviewAsOfDate('2026-01-01T21:30:00Z'),'2026-01-01');assert.equal(reviewAsOfDate('2026-07-01T21:30:00Z'),'2026-07-02');assert.equal(reviewAsOfDate('2024-02-29'),'2024-02-29');
 for(const asOf of ['2023-02-29','2024-02-30T10:00:00Z','2026-13-01','2026-01-01T10:00:00','nonsense'])assert.throws(()=>filterDecisionReviews([{reviewOn:null}],{mode:'all',asOf}));
 assert.throws(()=>decisionReviewState('2023-02-29','2024-02-29'));assert.throws(()=>decisionReviewState('2024-02-29T00:00:00Z','2024-02-29'));
});
test('both pure browse filters enforce the existing bounded snapshot size',()=>{
 assert.throws(()=>filterEvidenceDates(Array(REVIEW_BROWSE_LIMIT+1).fill(evidence[0]),{field:'observedAt'}),/limit/);assert.throws(()=>filterDecisionReviews(Array(REVIEW_BROWSE_LIMIT+1).fill({reviewOn:null}),{mode:'all',asOf:'2024-02-29'}),/limit/);
});
