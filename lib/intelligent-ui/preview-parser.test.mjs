import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { parseUiPlanPrefix: parse } = await createJiti(import.meta.url).import('./preview-parser.ts');

test('every character boundary remains a strict prefix without repaired nested members', () => {
  const source = '{"title":"括号 } ] \\" \\u4e2d \\\\","inputs":[{"value":-12.35e+2,"options":[true,false,null,"x"]},{"value":2}],"derived":[]}';
  const expected = JSON.parse(source);
  for (let end = 0; end < source.length; end++) {
    const prefix = parse(source.slice(0, end));
    assert.equal(prefix.status, 'partial', `boundary ${end}`);
    for (const [key, value] of Object.entries(prefix.values)) {
      if (Array.isArray(value)) assert.deepEqual(value, expected[key].slice(0, value.length));
      else assert.deepEqual(value, expected[key]);
    }
  }
  assert.deepEqual(parse(source).values, expected);
  assert.equal(parse(source).status, 'complete');
  assert.deepEqual(parse(source).completeKeys, ['title', 'inputs', 'derived']);
});

test('open root arrays expose only closed members; numbers require a delimiter', () => {
  assert.deepEqual(parse('{"inputs":[{"value":1}, {"value":').values, { inputs: [{ value: 1 }] });
  assert.deepEqual(parse('{"inputs":[{"value":1},').completeKeys, []);
  assert.deepEqual(parse('{"number":12').values, {});
  assert.deepEqual(parse('{"number":12 ').values, { number: 12 });
  assert.deepEqual(parse('{"number":12e').values, {});
  assert.deepEqual(parse('{"name":"done"').values, { name: 'done' });
});

test('malformed continuations revoke all previously closed values', () => {
  for (const invalid of [
    '{"a":1,"a":', '{"a":1,"\\u0061":', '{"x":{"a":1,"a":2}}',
    '{"x":{"__proto__":1}}', '{"constructor":1}', '{"x":[{"prototype":1}]}',
    '{"a":1,}', '{"x":[1,]}', '{"x":01}', '{"x":+1}', '{"x":.2}', '{"x":1e+}',
    '{"x":1e999}', '{"x":truX}', '{"x":"\\q"}', '{"x":"\\u00xz"}', '{"x":"\n"}',
    '{"a":1} garbage', '[]', '{"x":[1 false]}', '{"x":{"ok":true,} }',
  ]) {
    const result = parse(invalid); assert.equal(result.status, 'invalid', invalid);
    assert.deepEqual(result.values, {}); assert.deepEqual(result.completeKeys, []);
  }
});

test('raw length, traversal and depth budgets include incomplete data', () => {
  assert.equal(parse(' '.repeat(64001)).status, 'invalid');
  assert.equal(parse('{"x":' + '['.repeat(10)).status, 'invalid');
  assert.equal(parse('{"x":[' + '0,'.repeat(20001)).status, 'invalid');
  assert.equal(parse('{"x":' + '['.repeat(6) + '1' + ']'.repeat(6) + '}').status, 'complete');
});
