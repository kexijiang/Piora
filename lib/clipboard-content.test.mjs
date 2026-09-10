import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { clipboardWebLink, clipboardTextMetrics } = await createJiti(import.meta.url).import("../desktop/src/clipboard-content.ts");

test('clipboard links accept ordinary web URLs but reject launch protocols, credentials and control characters', () => {
  assert.deepEqual(clipboardWebLink(' https://example.com/a?q=1#section '), { url: 'https://example.com/a?q=1#section', hostname: 'example.com' });
  for (const value of ['javascript:alert(1)', 'file:///C:/test.exe', 'data:text/html,test', 'ms-settings:privacy', 'https://name:secret@example.com/', 'https://exa\nmple.com/', 'https://example.com/a b', 'not a url', null, 'https://example.com/' + 'a'.repeat(8192)]) assert.equal(clipboardWebLink(value), null);
});

test('text metrics count Unicode code points without allocating a character array and treat CRLF as one line break', () => {
  assert.deepEqual(clipboardTextMetrics(''), { characters: 0, lines: 0 });
  assert.deepEqual(clipboardTextMetrics('你好😀\r\nnext\rfinal\n'), { characters: 16, lines: 4 });
  assert.deepEqual(clipboardTextMetrics('😀'), { characters: 1, lines: 1 });
});
