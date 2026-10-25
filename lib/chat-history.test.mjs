import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { buildVirtualOffsets, virtualRange } from './virtual-window.ts';
const { buildChatHistoryRows, insertCommandHistoryRows, layoutChatResponseRows, messageFingerprint } = await createJiti(import.meta.url).import('./chat-history.ts');
const { buildCompactChatHistoryRows } = await createJiti(import.meta.url).import('./compact-chat-history.ts');
const assistant = content => ({ role:'assistant', content, timestamp:2 });
const text = value => ({type:'text',text:value});

test('both layouts suppress intermediate footers across shell steps, live turns and split final messages', () => {
  const call = id => ({type:'toolCall',toolName:'bash',toolCallId:id,input:{command:'echo hello'}});
  const messages = [{role:'user',content:'run'}, assistant([text('starting'), call('one')]),
    {role:'toolResult',toolCallId:'one',content:[text('hello')]}, assistant([text('next'),call('two')]),
    {role:'toolResult',toolCallId:'two',content:[text('hello')]}, assistant([{type:'thinking',thinking:'verified'},text('done')])];
  const ids = messages.map((_, i) => String(i));
  for (const build of [buildChatHistoryRows, buildCompactChatHistoryRows]) {
    for (const busy of [true, false]) {
      const plan = build(messages, ids, busy, new Set(['process:0','compact-process:0']));
      const rows = layoutChatResponseRows(plan.rows, messages, busy).filter(row => row.message?.role === 'assistant');
      assert.ok(rows.length >= 3);
      for (const row of rows.slice(0,-1)) {
        assert.equal(row.intermediate, true);
        assert.equal(row.showTimestamp, false);
      }
      assert.equal(rows.at(-1).intermediate, busy);
    }
  }
  const nextTurn = [...messages,{role:'user',content:'again'},assistant([call('three')])];
  const rows = layoutChatResponseRows(buildChatHistoryRows(nextTurn, ids, true, new Set()).rows,nextTurn,true);
  assert.equal(rows.find(row => row.index === 5 && !row.intermediate).message.content.at(-1).text, 'done');
  assert.equal(rows.at(-1).intermediate,true);
  const compacting = [messages[0],assistant([text('continuing')]),{role:'custom',customType:'compaction',content:'summary'},assistant([call('after-compaction')])];
  const compactingRows = layoutChatResponseRows(buildChatHistoryRows(compacting, [], true, new Set()).rows,compacting,true);
  for (const row of compactingRows.filter(row => row.message?.role === 'assistant')) assert.equal(row.intermediate,true);
});

test('command cards use stable independent keys and anchors without changing SDK entry identities', () => {
  const messages = [{ role: 'user', content: 'earlier', timestamp: 100 }, assistant([text('answer')])];
  messages[1].timestamp = 200;
  const entryIds = ['user-entry', 'assistant-entry'];
  const plan = buildChatHistoryRows(messages, entryIds, false, new Set());
  const cards = [{ commandId: 'command-later', acceptedAt: 150, operation: { anchorEntryId: 'user-entry' } }, { commandId: 'command-first', acceptedAt: 125, operation: { anchorEntryId: 'user-entry' } }];
  const rows = insertCommandHistoryRows(plan.rows, messages, entryIds, cards);
  assert.deepEqual(rows.map(row => row.operation?.commandId ?? row.message.content), ['earlier', 'command-first', 'command-later', messages[1].content]);
  assert.equal(rows[1].key, 'operation:command-first');
  assert.deepEqual(entryIds, ['user-entry', 'assistant-entry']);
  assert.equal(plan.rows.length, 2);
});

test('unparsed recovery stays outside the transcript and leaves existing messages intact', () => {
  const messages = [{ role: 'user', content: 'later', timestamp: 100 }];
  const plan = buildChatHistoryRows(messages, ['entry'], false, new Set());
  const rows = insertCommandHistoryRows(plan.rows, messages, ['entry'], [{ commandId: 'pending', local: true, acceptedAt: 50, preview: '/missing args' }, { commandId: 'ordinary', acceptedAt: 75 }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows, plan.rows);
  assert.equal(rows[0].message, messages[0]);
});

test('command cards remain independent of collapsed compact process groups', () => {
  const messages = [{ role: 'user', content: 'work', timestamp: 1 }, assistant([{ type: 'toolCall', toolName: 'read', toolCallId: 'read', input: { path: 'file' } }]), { role: 'toolResult', toolCallId: 'read', content: [text('data')], timestamp: 3 }, assistant([text('done')])];
  const entryIds = ['user', 'tool', 'result', 'answer'];
  const plan = buildCompactChatHistoryRows(messages, entryIds, false, new Set());
  const rows = insertCommandHistoryRows(plan.rows, messages, entryIds, [{ commandId: 'reload-command', acceptedAt: 2, operation: { anchorEntryId: 'tool' } }]);
  assert.equal(rows.filter(row => row.operation).length, 1);
  assert.equal(rows.find(row => row.operation).key, 'operation:reload-command');
  assert.equal(rows.filter(row => row.compactProcess).length, 1);
});

test('empty aborted replies remain visible after history is restored', () => {
  const messages = [{ role: 'user', content: 'work' }, { ...assistant([]), stopReason: 'aborted', errorMessage: 'This operation was aborted' }];
  const { rows } = buildChatHistoryRows(messages, ['u', 'a'], false, new Set());
  assert.equal(rows.length, 2);
  assert.equal(rows[1].message.stopReason, 'aborted');
});

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

test('ordinary submissions never create command cards in chat history', () => {
  const records = ['cancelled','accepted','failed','interrupted','expired'].map(status=>({commandId:status,status,local:status==='accepted',acceptedAt:1}));
  const rows = insertCommandHistoryRows([],[],[],records);
  assert.deepEqual(rows,[]);
});
