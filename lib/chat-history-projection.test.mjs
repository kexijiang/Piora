import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { prepareChatHistory, projectChatHistoryTail } = await jiti.import('./chat-history-projection.ts');
const { buildCompactChatHistoryRows } = await jiti.import('./compact-chat-history.ts');
const { insertCommandHistoryRows, layoutChatResponseRows } = await jiti.import('./chat-history.ts');
const { insertModelChangeRows } = await jiti.import('./model-change-notices.ts');
const text = text => ({ type: 'text', text });
const user = (content, timestamp) => ({ role: 'user', content, timestamp });
const assistant = (content, timestamp = 20) => ({ role: 'assistant', content, timestamp });
const call = id => ({ type: 'toolCall', toolName: 'bash', toolCallId: id, input: { command: 'echo ok' } });

test('incremental projection preserves full projection across live, settled, recovered and edited histories', () => {
  const history = [user('first', 1), assistant([{ type: 'thinking', thinking: 'plan' }, call('a'), text('done')], 2),
    { role: 'toolResult', toolCallId: 'a', content: [text('ok')], timestamp: 3 },
    user('same text', 4), assistant([call('b')], 5), { role: 'custom', customType: 'compaction', content: 'summary', timestamp: 6 },
    { ...user('same text', 7), clientPromptId: 'recovery-one' }, { ...user('same text', 8), clientPromptId: 'recovery-two' }, assistant([text('working')], 9)];
  const histories = [[], history.slice(0, 1), history, history.slice(0, 6), [assistant([text('imported')])], history.filter((_, i) => i !== 3)];
  for (const saved of histories) for (const compact of [true, false]) for (const direct of [true, false]) for (const busy of [true, false]) {
    const ids = saved.map((m, i) => m.clientPromptId ? '' : `entry-${i}`);
    const choices = new Map([['compact-process:entry-0', false], ['compact-process:entry-3', true]]);
    const operations = [{ commandId: 'anchored', acceptedAt: 2, operation: { anchorEntryId: ids[1] } },
      { commandId: 'fallback', acceptedAt: 10, operation: {} }, { commandId: 'pending', acceptedAt: 5 }];
    const notices = [{ id: 'change', afterEntryId: ids[1], from: { provider: 'a', modelId: 'a' }, to: { provider: 'b', modelId: 'b' } }];
    const base = prepareChatHistory(saved, ids, choices, compact, direct, operations, notices);
    for (const live of [null, assistant([{ type: 'thinking', thinking: 'next' }, call('live'), text('growing')]),
      { ...assistant([]), stopReason: 'error', errorMessage: 'failed' }, { role: 'bashExecution', command: 'echo ok', output: 'ok', timestamp: 22 },
      { role: 'toolResult', toolCallId: 'a', content: [text('late failure')], isError: true, timestamp: 23 },
      { role: 'toolResult', toolCallId: 'live', content: [text('live result')], timestamp: 24 }]) {
      const messages = live ? [...saved, live] : saved;
      const expected = buildCompactChatHistoryRows(messages, ids, busy, choices, live ? saved.length : -1, compact, direct);
      expected.rows = insertModelChangeRows(layoutChatResponseRows(insertCommandHistoryRows(expected.rows, messages, ids, operations), messages, busy), ids, notices);
      const actual = projectChatHistoryTail(base, live, busy);
      assert.deepEqual(actual.rows, expected.rows, JSON.stringify({ count: saved.length, compact, direct, busy, live: live?.role }));
      for (const id of ids) {
        assert.equal(actual.entryRows.get(id), expected.entryRows.get(id));
        assert.equal(actual.entryGroups.get(id), expected.entryGroups.get(id));
      }
    }
  }
});

test('streaming updates never inspect completed turn content and retain their row identities', () => {
  let historicalReads = 0;
  const saved = Array.from({ length: 1000 }, (_, i) => [user(`question-${i}`, i * 3), {
    role: 'assistant', timestamp: i * 3 + 1,
    get content() { historicalReads++; return [text(`answer-${i}`)]; },
  }]).flat();
  saved.push(user('current', 3001));
  const ids = saved.map((_, i) => `id-${i}`);
  const base = prepareChatHistory(saved, ids, new Map(), false, true, [], []);
  historicalReads = 0;
  let first;
  for (let i = 1; i <= 100; i++) {
    const result = projectChatHistoryTail(base, assistant([text('token '.repeat(i))], 3002), true);
    if (!first) first = result;
    assert.equal(result.rows[1], first.rows[1]);
    assert.equal(result.toolResults, first.toolResults);
  }
  assert.equal(historicalReads, 0, 'old content must not be parsed on each streaming update');
});

test('new tool results, history replacement and recovery IDs invalidate the saved projection', () => {
  const saved = [user('old', 1), assistant([call('one')]), { ...user('recover', 3), clientPromptId: 'pending-1' }];
  const ids = ['u', 'a', ''];
  const before = prepareChatHistory(saved, ids, new Map(), true, false, [], []);
  assert.equal(before.rows.find(row => row.compactProcess)?.compactProcess.attention, true);
  const next = [saved[0], saved[1], { role: 'toolResult', toolCallId: 'one', content: [text('ok')] }, saved[2]];
  const after = prepareChatHistory(next, ['u', 'a', 'result', ''], new Map(), true, false, [], []);
  assert.equal(after.rows.find(row => row.compactProcess)?.compactProcess.attention, false);
  assert.ok(projectChatHistoryTail(after, null, false).rows.some(row => row.key === 'message:pending-1'));
  assert.equal(projectChatHistoryTail(prepareChatHistory([], [], new Map(), false, true, [], []), null, false).rows.length, 0);
});
