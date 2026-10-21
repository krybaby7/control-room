import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sanitizeChatSource} from '../companion/chat-context.mjs';
const user=text=>({role:'user',text}), assistant=text=>({role:'assistant',text});
const select=messages=>sanitizeChatSource({status:'included',match:'cwd',latestAt:'2026-10-21T10:00:00Z',messages},'codex');
test('standalone request excludes following assistant and long templates',()=>{
  const result=select([user('Template instructions '.repeat(80)),assistant('Old answer.'),user('Please fix the save button.'),assistant('Long answer '.repeat(200))]);
  assert.deepEqual(result.messages,[user('Please fix the save button.')]);
  assert.equal(result.source.truncated,true);
});
test('fenced code and structured large template defer behind ordinary prose',()=>{
  const result=select([user('```js\nconst value = 1;\n```'),user(Array.from({length:12},(_,i)=>`## Section ${i}\n- perform task ${i}`).join('\n')),user('Keep the page simple.')]);
  assert.deepEqual(result.messages,[user('Keep the page simple.')]);
});
test('context-dependent English and Arabic input retains nearest preceding safe answer only',()=>{
  for(const text of ['Yes, do option two.','option 2','that','continue','please use option 2','I prefer option two','نعم','تمام، كمل']) {
    const result=select([assistant('Old irrelevant answer.'),assistant('Choose option one or option two.'),user(text),assistant('Following answer.')]);
    assert.deepEqual(result.messages,[assistant('Choose option one or option two.'),user(text)]);
  }
});
test('standalone requests beginning with acknowledgment-like words exclude assistant context',()=>{
  for(const text of ['This button should save the draft.','That page needs a heading.','No trading actions should run.','Continue showing the saved status after refresh.','Yes, the export contains duplicate rows.','لا تشغل أي عمليات تداول.','تمام التصميم يحتاج عنوان جديد']){
    const result=select([assistant('Unrelated earlier answer.'),user(text)]);
    assert.deepEqual(result.messages,[user(text)]);
  }
});
test('assistant context has a shared 600 character budget and preserves beginning and end',()=>{
  const result=select([assistant('START '+ 'x'.repeat(900)+' END'),user('yes'),assistant('SECOND '+ 'y'.repeat(900)+' LAST'),user('continue')]);
  const contexts=result.messages.filter(m=>m.role==='assistant');
  assert(contexts.reduce((n,m)=>n+m.text.length,0)<=600);
  assert(contexts.some(m=>m.text.startsWith('SECOND ')&&m.text.endsWith(' LAST')&&m.text.includes('[… omitted …]')));
});
test('latest safe long user fallback preserves beginning and end with explicit omission',()=>{
  const result=select([user('old '.repeat(300)),assistant('answer'),user('BEGIN '+ 'middle '.repeat(300)+' END')]);
  assert.equal(result.messages.length,1);
  assert.equal(result.messages[0].role,'user');
  assert.equal(result.messages[0].text.length,1000);
  assert(result.messages[0].text.startsWith('BEGIN '));
  assert(result.messages[0].text.endsWith(' END'));
  assert(result.messages[0].text.includes('[… omitted …]'));
});
test('assistant-only safe history is deferred without an excerpt',()=>{
  const result=select([assistant('Safe answer')]);
  assert.equal(result.source.status,'deferred');
  assert.deepEqual(result.messages,[]);
  assert.equal(result.source.excerptSha256,null);
  assert.equal(result.source.truncated,true);
});
test('newest complete concise user messages retain chronology within budget',()=>{
  const rows=Array.from({length:6},(_,i)=>user((`${i}: `+'ordinary prose '.repeat(49)).trim()));
  const result=select(rows);
  assert.deepEqual(result.messages,rows.slice(-2));
  assert(result.source.characters<=2000);
  assert.equal(result.source.messages,2);
  const expected=createHash('sha256').update(JSON.stringify({provider:'codex',latestAt:'2026-10-21T10:00:00.000Z',messages:result.messages})).digest('hex');
  assert.equal(result.source.excerptSha256,expected);
});
test('secret filtering happens before fallback clipping and paths are redacted',()=>{
  const result=select([user('safe '.repeat(300)+' api_key="secret-value-long-enough"'),assistant('Safe answer')]);
  assert.equal(result.messages.length,0);
  assert(['filtered','deferred'].includes(result.source.status));
  const safe=select([user('Please inspect\nC:\\Users\\private\\repo')]);
  assert(!JSON.stringify(safe).includes('private'));
});
test('selection never expands the last-six candidate window',()=>{
  const result=select([user('Outside candidate window.'),...Array.from({length:6},()=>assistant('Answer'))]);
  assert.equal(result.source.status,'deferred');
  assert.deepEqual(result.messages,[]);
});
test('context never crosses intervening user or filtered message boundaries',()=>{
  for(const middle of [user('Please change the color.'),user('api_key="secret-value-long-enough"'),assistant('api_key="secret-value-long-enough"')]){
    const result=select([assistant('Unrelated earlier options.'),middle,user('yes')]);
    assert(!result.messages.some(row=>row.role==='assistant'));
  }
});
test('tiny remaining context budget cannot overflow when only an omission marker fits',()=>{
  const result=select([assistant('x'.repeat(900)),user('yes'),assistant('y'.repeat(600-'[… omitted …]'.length)),user('continue')]);
  assert(result.messages.filter(row=>row.role==='assistant').reduce((n,row)=>n+row.text.length,0)<=600);
});
