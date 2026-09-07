import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { buildVirtualOffsets, virtualRange } from './virtual-window.ts';
const { buildChatHistoryRows, messageFingerprint } = await createJiti(import.meta.url).import('./chat-history.ts');
const assistant = content => ({ role:'assistant', content, timestamp:2 });
const text = value => ({type:'text',text:value});

test('completed shell output stays visible in the main conversation', () => {
  const messages = [{role:'user',content:'run'}, assistant([{type:'toolCall',toolName:'bash',toolCallId:'b',input:{command:'echo hello'}}]), {role:'toolResult',toolCallId:'b',content:[text('hello')]}, assistant([text('done')])];
  const {rows} = buildChatHistoryRows(messages, ['u','b','r','a'], false, new Set());
  assert.ok(rows.some(row => row.message === messages[1]));
  assert.equal(rows.filter(row => row.process).length, 0);
});

test('large completed turns collapse process work; expanded processes remain individually windowable', () => {
  const messages = [{role:'user',content:'work',timestamp:1}];
  for(let i=0;i<6000;i++) messages.push(assistant([{type:'toolCall',toolName:'read',toolCallId:String(i),input:{path:'a'}}]));
  messages.push(assistant([text('done')]));
  const ids=messages.map((_,i)=>`entry-${i}`);
  const collapsed=buildChatHistoryRows(messages,ids,false,new Set());
  assert.equal(collapsed.rows.length,3);
  assert.equal(collapsed.rows[1].process.count,6000);
  assert.equal(collapsed.rows[1].process.toolCalls,6000);
  assert.equal(collapsed.entryRows.get('entry-3000'),'process:entry-0');
  const expanded=buildChatHistoryRows(messages,ids,false,new Set(['process:entry-0']));
  assert.equal(expanded.rows.length,6003);
  const keys=expanded.rows.map(row=>row.key);
  const offsets=buildVirtualOffsets(keys,new Map(),160);
  const target=keys.indexOf(expanded.entryRows.get('entry-3000'));
  const range=virtualRange(offsets,offsets[target],800);
  assert.ok(range.start<=target && range.end>target);
  assert.ok(range.end-range.start<=18);
});

test('keeps file changes visible and assigns final usage only once', () => {
  const final={...assistant([{type:'thinking',thinking:'reason'},text('done')]),usage:{input:3,output:5}};
  const messages=[{role:'user',content:'edit'},assistant([{type:'toolCall',toolName:'edit',toolCallId:'edit-1',input:{path:'a'}}]),final];
  const {rows}=buildChatHistoryRows(messages,['u','change','a'],false,new Set());
  assert.equal(rows.filter(row=>row.process).length,0);
  assert.ok(rows.some(row=>row.message?.content?.some?.(block=>block.toolName==='edit')));
  assert.equal(rows.filter(row=>row.message?.usage).length,1);
  assert.equal(rows.at(-1).message.usage,final.usage);
});

test('compaction anchors collapse completed work; running turns preserve every message', () => {
  const messages=[{role:'custom',customType:'compaction',content:'summary'},assistant([{type:'toolCall',toolName:'read',toolCallId:'a',input:{}}]),assistant([text('done')])];
  assert.ok(buildChatHistoryRows(messages,['c','p','a'],false,new Set()).rows[1].process);
  const running=buildChatHistoryRows(messages,['c','p','a'],true,new Set());
  assert.equal(running.rows.length,3);
  assert.equal(running.rows[1].message,messages[1]);
  assert.doesNotThrow(()=>messageFingerprint({role:'assistant',content:undefined}));
});

test('virtual ranges recycle both directions and offscreen lists mount nothing', () => {
  const keys=Array.from({length:10000},(_,i)=>String(i));
  const offsets=buildVirtualOffsets(keys,new Map([['5000',800]]),35);
  for(const top of [0,offsets[5000],offsets[9990],35]) {
    const range=virtualRange(offsets,top,700);
    assert.ok(range.end-range.start<=33);
    assert.ok(range.start>=0 && range.end<=keys.length);
  }
  assert.deepEqual(virtualRange(offsets,-3000,700),{start:0,end:0});
  assert.deepEqual(virtualRange([0],0,700),{start:0,end:0});
});
