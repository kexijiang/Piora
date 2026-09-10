import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createJiti } from 'jiti';
import ts from 'typescript';
const { clipboardMessage, clipboardEnglish } = await createJiti(import.meta.url).import('../desktop/src/clipboard-messages.ts');

test('clipboard interface messages have English copy and matching interpolation fields', async () => {
  const paths = (await readdir('components/clipboard')).filter(name => /\.tsx?$/.test(name)).map(name => 'components/clipboard/' + name);
  paths.push('components/ClipboardWorkbench.tsx');
  const missing = [];
  for (const path of paths) {
    const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tr' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const message = node.arguments[0].text;
        if (/\p{Script=Han}/u.test(message) && !Object.hasOwn(clipboardEnglish, message)) missing.push(path + ': ' + message);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, []);
  const fields = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [source, translation] of Object.entries(clipboardEnglish)) assert.deepEqual(fields(translation), fields(source), source);
});

test('translation preserves user values and handles owned migration messages', () => {
  const title = '我的备注 {count} <script> & 😀';
  assert.equal(clipboardMessage('en', '操作 {title}', { title }), 'Actions for ' + title);
  assert.equal(clipboardMessage('en', '「' + title + '」已有不同备注，保留当前备注。'), '“' + title + '” already has a different note. The current note was kept.');
  assert.equal(clipboardMessage('en', '旧记录 12 未导入：格式错误'), 'Legacy item 12 was not imported: Invalid format');
  assert.equal(clipboardMessage('en', 'unrecognized error {value}'), 'unrecognized error {value}');
  assert.equal(clipboardMessage('zh-CN', '操作 {title}', { title }), '操作 ' + title);
});
