import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, linkSync, symlinkSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { validateUiActions, validateActionPath, UI_ACTION_LIMITS } = await jiti.import('./action-contract.ts');
const { inspectActionFile, readActionParameters, actionSnapshotBytes, createActionSnapshot, reconcileActionSnapshot } = await jiti.import('./action-files.ts');
const save = { id: 'save', label: '保存方案', kind: 'save_snapshot', path: 'report.json', format: 'json' };
const query = { id: 'load', label: '读取参数', kind: 'read_json_parameters', path: 'parameters.json' };
const surface = { version: 1, id: 'bill', revision: 3, title: '<script>danger()</script>', nodes: [
  { id: 'people', type: 'number', label: '人数', value: 4, min: 1, max: 20 },
  { id: 'transport', type: 'select', label: '交通', value: '火车', options: ['火车', '飞机'] },
  { id: 'member', type: 'checkbox', label: '会员', value: false },
  { id: 'cost', type: 'metric', label: '费用', value: { op: 'multiply', args: [{ ref: 'people' }, 20] } },
] };
const state = { people: 6, transport: '飞机', member: true };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'piora-action-files-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }); });
  const cwd = join(root, 'project'), outside = join(root, 'outside'); mkdirSync(cwd); mkdirSync(outside);
  return { cwd, outside };
}
test('registered declarations reject dynamic authority, duplicates, executable paths and malformed arrays', () => {
  assert.deepEqual(validateUiActions({ version: 1, actions: [query, save] }), { version: 1, actions: [query, save] });
  for (const actions of [[{ ...save, kind: 'shell', command: 'echo x' }], [{ ...save, force: true }], [save, save],
    [{ ...save, format: 'html', path: 'index.html' }], [{ ...query, format: 'json' }], Array(9).fill(save), Array(1)]) {
    assert.throws(() => validateUiActions({ version: 1, actions }));
  }
  let called = false;
  const getter = Object.defineProperty([], '0', { get() { called = true; return save; }, enumerable: true });
  assert.throws(() => validateUiActions({ version: 1, actions: getter })); assert.equal(called, false);
  for (const path of ['../escape.json', '/tmp/a.json', 'C:/a.json', '\\\\server/share/a.json', 'report.json:stream', './a.json',
    'a//b.json', 'a/../b.json', '.env', 'secrets/auth.json', 'a/credentials.txt', 'NUL.json', 'CONOUT$.json', 'a/COM1.md',
    'file://report.json', '~/report.json', 'report.json ', 'folder./a.json', 'report\u0000.json']) {
    assert.throws(() => validateActionPath(path), undefined, path);
  }
  assert.equal(validateActionPath('旅行/费用.json'), '旅行/费用.json');
});
test('bounded JSON queries return validated proposed values without changing the source or UI state', t => {
  const f = fixture(t), path = join(f.cwd, query.path), text = JSON.stringify(state); writeFileSync(path, text);
  const evidence = inspectActionFile(f.cwd, query);
  assert.deepEqual(readActionParameters(f.cwd, query, surface, evidence).state, state);
  assert.equal(readFileSync(path, 'utf8'), text); assert.equal(surface.nodes[0].value, 4);
  writeFileSync(path, JSON.stringify({ ...state, people: 8 }));
  assert.throws(() => readActionParameters(f.cwd, query, surface, evidence), /changed/);
  for (const text of ['{"people":6,"people":8,"transport":"飞机","member":true}', JSON.stringify({ ...state, people: 30 }),
    JSON.stringify({ ...state, extra: 'x' }), JSON.stringify({ people: 6 }), '{"people":', '{"__proto__":{}}']) {
    writeFileSync(path, text);
    assert.throws(() => readActionParameters(f.cwd, query, surface, inspectActionFile(f.cwd, query)), undefined, text);
  }
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0x80]));
  assert.throws(() => readActionParameters(f.cwd, query, surface, inspectActionFile(f.cwd, query)), /UTF-8/);
  writeFileSync(path, Buffer.alloc(UI_ACTION_LIMITS.fileBytes + 1)); assert.throws(() => inspectActionFile(f.cwd, query), /budget/);
});
test('save derives current calculations and creates once without overwriting an existing file', t => {
  const f = fixture(t), bytes = actionSnapshotBytes(save, surface, state), before = inspectActionFile(f.cwd, save);
  let checks = 0;
  const result = createActionSnapshot(f.cwd, save, bytes, before, () => { checks++; });
  assert.equal(checks, 2); assert.equal(result.sha256, hash(bytes));
  const actual = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.deepEqual(actual.parameters, state); assert.match(actual.snapshot, /费用: 120/); assert.equal(actual.surfaceRevision, 3);
  assert.equal(reconcileActionSnapshot(f.cwd, save, result.sha256), 'matching');
  assert.throws(() => createActionSnapshot(f.cwd, save, bytes, before, () => {}), /exists|changed/);
  assert.deepEqual(readFileSync(result.path), bytes);
  const markdown = actionSnapshotBytes({ ...save, path: 'report.md', format: 'markdown' }, { ...surface, title: surface.title + '\r<script>second()</script>' }, state).toString('utf8');
  assert.ok(markdown.startsWith('    <script>')); assert.ok(markdown.trimEnd().split('\n').every(line => line.startsWith('    ')));
  assert.match(markdown, /\n    <script>second/); assert.equal(markdown.includes('\r'), false);
});
test('denial has no effect before creation; interrupted writes remain inspectable and are not retried', t => {
  const f = fixture(t), bytes = actionSnapshotBytes(save, surface, state), before = inspectActionFile(f.cwd, save);
  assert.throws(() => createActionSnapshot(f.cwd, save, bytes, before, () => { throw new Error('denied'); }), /denied/);
  assert.equal(existsSync(join(f.cwd, save.path)), false);
  let checks = 0;
  assert.throws(() => createActionSnapshot(f.cwd, save, bytes, before, () => { if (++checks === 2) throw new Error('cancelled'); }), error => error.code === 'UNCERTAIN');
  assert.equal(readFileSync(join(f.cwd, save.path)).length, 0);
  assert.equal(reconcileActionSnapshot(f.cwd, save, hash(bytes)), 'different');
  assert.throws(() => createActionSnapshot(f.cwd, save, bytes, before, () => {}));
  assert.equal(reconcileActionSnapshot(f.cwd, { ...save, path: 'missing.json' }, hash(bytes)), 'missing');
});
test('junctions, hardlinks, missing parents and replaced target directories invalidate file operations', t => {
  const f = fixture(t);
  writeFileSync(join(f.outside, 'parameters.json'), JSON.stringify(state));
  symlinkSync(f.outside, join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectActionFile(f.cwd, { ...query, path: 'linked/parameters.json' }), /real directories/);
  assert.throws(() => inspectActionFile(f.cwd, { ...save, path: 'new/report.json' }), /parent/);
  linkSync(join(f.outside, 'parameters.json'), join(f.cwd, query.path));
  assert.throws(() => inspectActionFile(f.cwd, query), /Linked/);
  const nested = { ...save, path: 'reports/report.json' }; mkdirSync(join(f.cwd, 'reports'));
  const evidence = inspectActionFile(f.cwd, nested); renameSync(join(f.cwd, 'reports'), join(f.cwd, 'old')); mkdirSync(join(f.cwd, 'reports'));
  assert.throws(() => createActionSnapshot(f.cwd, nested, actionSnapshotBytes(nested, surface, state), evidence, () => {}), /changed/);
  assert.equal(existsSync(join(f.cwd, nested.path)), false);
});
