// Apache-2.0; ported from dsh-harmoneydev-tools, see third_party/harmony-log-workbench/SOURCE.md.
import { rar4Fixture, rar5Fixture } from './archive-fixtures.mjs';
import { parseRarListing } from '../vendor/log-rar.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync, crc32, gunzipSync } from 'node:zlib';
import { createLogLibrary } from '../vendor/log-library.mjs';
import { logAnalysisPrompt, directoryAnalysisPrompt } from '../vendor/log-client.mjs';
import { TEXT_BYTES, PACKAGE_BYTES, EXPANDED_BYTES } from '../vendor/log-limits.mjs';
const A = { sessionId: 'package-A' }, B = { sessionId: 'package-B' };
const line = (bundle, text, pid = 11) => `10-16 00:01:02.003 ${pid} 12 I C00123/${bundle}/Work: ${text}\n`;
export function zipFixture(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, content, attributes = 0] of entries) {
    const nameBytes = Buffer.from(name), bytes = Buffer.from(content), crc = crc32(bytes), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, bytes); const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(attributes >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, nameBytes); offset += header.length + nameBytes.length + bytes.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, index, end]);
}
async function fixture(fn, options) { const root = await mkdtemp(join(tmpdir(), 'dsh-packages-')), library = createLogLibrary(root, options); try { await fn(library, root); } finally { await library.dispose(); await rm(root, { recursive: true, force: true }); } }
async function upload(library, name, source, extra = {}, scope = A) { const bytes = Buffer.from(source), value = await library.begin({ name, size: bytes.length, ...extra }, scope); for (let i = 0, at = 0; at < bytes.length; i++, at += 262144) await library.chunk(value.id, i, bytes.subarray(at, at + 262144), scope); return library.finish(value.id, scope); }

test('目录只属于当前会话；改名不改路径，移动后删除直接释放原文件且不可恢复', () => fixture(async (library, root) => {
  const group = await library.createGroup('批次一', A), single = await upload(library, '临时.log', line('test.app', 'single'));
  assert.equal((await library.list(0, 20, A, { groupId: '' })).total, 1);
  await assert.rejects(library.move([single.id], group.id, B)); await assert.rejects(library.renameGroup(group.id, '外部', B));
  await library.move([single.id], group.id, A); assert.equal((await library.list(0, 20, A, { groupId: '' })).total, 0);
  const before = await library.analysis({ groupId: group.id }, A); await library.renameGroup(group.id, '重命名批次', A); const after = await library.analysis({ groupId: group.id }, A); assert.equal(before.directory, after.directory);
  const source = await library.source(single.id, A);
  const removed = await library.deleteGroup(group.id, A); assert.equal((await library.groups(A)).groups.length, 0); assert.equal(removed.removed, 1); assert.equal(removed.permanent, true); assert.equal(removed.batchId, undefined);
  await assert.rejects(readFile(source.path), /ENOENT/); await assert.rejects(library.info(single.id, A)); assert.equal((await library.trash(0, 20, A)).total, 0);
  await assert.rejects(readdir(join(root, 'log-library', 'trash')), /ENOENT/);
}));
test('全量离线日志按明确包名过滤；同PID、近似包名与消息里的包名不误归属', () => fixture(async library => {
  const file = await upload(library, 'all.log', line('test.app', 'ok') + line('test.app:worker', 'child') + line('test.app2', 'other') + '10-16 00:01:02.003 11 12 I C00123 Work: mentions test.app\n');
  const page = await library.getLogs(file.id, { bundle: 'test.app', limit: 1000 }, A); assert.equal(page.filteredTotal, 2); assert.ok(page.entries.every(e => e.bundle === 'test.app'));
  assert.equal((await library.getLogs(file.id, { bundle: '__unknown__' }, A)).filteredTotal, 1);
  assert.equal(page.applications.length, 2); assert.equal(page.applications.find(a => a.bundle === 'test.app').count, 2);
}));
test('ZIP保留内部相对路径，原包可下载；普通文本GZ自动解析到同一目录', () => fixture(async library => {
  const raw = line('test.app', 'gzip-text'), source = zipFixture([['folder/one.log', line('test.app', 'first')], ['other/one.log', line('other.app', 'second')], ['third.log.gz', gzipSync(raw)], ['ignored.exe', Buffer.from('never execute')]]);
  const packed = await upload(library, '测试包.zip', source); assert.equal(packed.files.length, 3); assert.equal(packed.parsingStatus, 'complete'); assert.ok(packed.groupId);
  assert.deepEqual(await readFile((await library.source(packed.id, A)).path), source);
  const paths = packed.files.map(f => f.origin.relativePath); assert.ok(paths.includes('folder/one.log')); assert.ok(paths.includes('other/one.log'));
  const again = await upload(library, '测试包.zip', source, { groupId: packed.groupId }); assert.equal(again.reused, true); assert.equal(again.id, packed.id);
  await assert.rejects(library.retryPackage(packed.id, B));
}));
test('无字典保留二进制HiLog，补入同目录字典后可重试；不会重复生成已解析文件', () => fixture(async library => {
  const packed = await upload(library, 'hilog.001.gz', gzipSync(Buffer.from([0, 1, 2, 3]))); assert.equal(packed.parsingStatus, 'needs-dictionary'); assert.equal(packed.files.length, 0);
  await upload(library, 'hilog_dict.test.zip', zipFixture([['dict', 'value']]), { groupId: packed.groupId });
  const retried = await library.retryPackage(packed.id, A); assert.equal(retried.parsingStatus, 'complete'); assert.equal(retried.files.length, 1);
  const third = await library.retryPackage(packed.id, A); assert.equal(third.files[0].id, retried.files[0].id);
  await upload(library, 'hilog_dict.new.zip', zipFixture([['dict', 'new-value']]), { groupId: packed.groupId });
  const previousSource = await library.source(third.files[0].id, A);
  const refreshed = await library.retryPackage(packed.id, A); assert.notEqual(refreshed.files[0].id, third.files[0].id); assert.equal((await library.trash(0, 20, A)).total, 0); await assert.rejects(readFile(previousSource.path), /ENOENT/);
}, { runHilogTool: async (tool, args, signal, cwd) => { const output = join(cwd, args[args.indexOf('-o') + 1]); await mkdir(output, { recursive: true }); await writeFile(join(output, 'decoded.log'), line('test.app', 'decoded')); return '200'; } }));
test('ZIP路径穿越、链接、同名覆盖及坏包被拒绝，原包仍可取回', () => fixture(async library => {
  for (const [name, source] of [['escape.zip', zipFixture([['../escape.log', 'x']])], ['link.zip', zipFixture([['link.log', 'x', 0xa1ff0000]])], ['duplicate.zip', zipFixture([['a.log', 'a'], ['a.log', 'b']])], ['bad.zip', Buffer.from('not zip')]]) {
    await assert.rejects(upload(library, name, source)); const file = (await library.list(0, 100, A)).files.find(f => f.name === name); assert.equal(file.parsingStatus, 'failed'); assert.deepEqual(await readFile((await library.source(file.id, A)).path), source);
  }
}));
test('分块压缩可读1000条、连续分页不遗漏；原始大文件压缩后逐字节还原', () => fixture(async library => {
  const text = Array.from({ length: 6500 }, (_, i) => line(i % 2 ? 'test.app' : 'other.app', i + ' ' + 'x'.repeat(200))).join('');
  const file = await upload(library, 'large.log', text), source = await library.source(file.id, A); assert.equal(file.sourceCompression, 'gzip'); assert.deepEqual(gunzipSync(await readFile(source.path)), Buffer.from(text));
  const first = await library.getLogs(file.id, { limit: 1000 }, A); assert.equal(first.entries.length, 1000); assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1100000);
  let offset = 0, seen = 0; do { const page = await library.getLogs(file.id, { bundle: 'test.app', limit: 1000, offset }, A); for (const e of page.entries) { assert.equal(parseInt(e.message), seen * 2 + 1); seen++; } offset = page.nextOffset; } while (offset !== null); assert.equal(seen, 3250);
  assert.ok(file.storedBytes < Buffer.byteLength(text) / 3); assert.ok(!(await readdir(dirname(source.path))).includes('app-logs.jsonl'));
}));
test('分析草稿包含可直接读取的真实路径，保留源行号及目录清单；不暴露敏感值', () => fixture(async library => {
  const file = await upload(library, 'analysis.log', '\n' + line('test.app', 'token=secret-value') + '\n' + line('test.app', 'second'));
  const prepared = await library.analysis({ id: file.id }, A), entry = prepared.files[0], text = await readFile(entry.path, 'utf8'); assert.equal(text.split('\n')[1].includes('[redacted]'), true); assert.ok(!text.includes('secret-value'));
  const prompt = logAnalysisPrompt({ ...file, analysisPath: entry.path, manifestPath: prepared.manifestPath }); assert.ok(prompt.includes(entry.path)); assert.ok(prompt.includes(prepared.manifestPath)); assert.doesNotMatch(prompt, /e2e_phone/);
  const directory = await library.analysis({ groupId: '' }, A); assert.ok(directoryAnalysisPrompt(directory).includes(directory.manifestPath)); assert.equal(JSON.parse(await readFile(directory.manifestPath, 'utf8')).files[0].path, entry.path); await assert.rejects(library.analysis({ id: file.id }, B));
}));
test('常用包名收藏跨会话共享、重启保留；未知字段不覆盖配置', () => fixture(async (library, root) => {
  await library.preferences(A, { bundle: 'test.app', label: '测试应用', favorite: true }); assert.equal((await library.preferences(B)).favorites[0].bundle, 'test.app');
  const restarted = createLogLibrary(root); try { assert.equal((await restarted.preferences(A)).favorites.length, 1); await restarted.preferences(A, { bundle: 'test.app', favorite: false }); assert.equal((await library.preferences(B)).favorites.length, 0); } finally { await restarted.dispose(); }
  await assert.rejects(library.preferences(A, { bundle: '../bad', favorite: true }));
}));

test('RAR4 and RAR5 extract supported logs through bounded stdout and preserve original archive',()=>fixture(async library=>{
 for(const [name,make] of [['rar4.rar',rar4Fixture],['rar5.rar',rar5Fixture]]){
  const raw=line('test.app',name),source=make([['logs/device.log',raw],['ignore.exe','never execute']]);
  const packed=await upload(library,name,source);assert.equal(packed.parsingStatus,'complete');assert.equal(packed.files.length,1);assert.equal(packed.files[0].count,1);assert.equal(packed.files[0].origin.relativePath,'logs/device.log');assert.deepEqual(await readFile((await library.source(packed.id,A)).path),source);
 }
}));
test('RAR listing rejects traversal, links, encryption, duplicate destinations and oversized expansion',()=>{
 const safe=n=>{if(n.includes('..'))throw Error('unsafe');return n;};
 const listing=extra=>'Path = device.log\nSize = 5\nFolder = -\nEncrypted = -\n'+extra;
 for(const text of [listing('Symbolic Link = target'),listing('Encrypted = +'),listing('Split After = +'),listing('Size = 99999999999'),'Path = ../escape.log\nSize = 1',listing('')+'\n\n'+listing('')])assert.throws(()=>parseRarListing(text,safe,{bytes:0},()=>100,1000,100));
});
test('UTF-16 GZ and late invalid UTF-8 preserve readable data with explicit encoding or replacement warnings',()=>fixture(async library=>{
 const original=line('test.app','中文正文'),utf16=Buffer.concat([Buffer.from([255,254]),Buffer.from(original,'utf16le')]);
 const packed=await upload(library,'utf16.log.gz',gzipSync(utf16));assert.equal(packed.parsingStatus,'complete');assert.equal(packed.files[0].encoding,'utf-16le');assert.ok((await library.getLogs(packed.files[0].id,{},A)).logCollection.warnings.some(w=>w.includes('UTF-16LE')));assert.equal((await library.getLogs(packed.files[0].id,{},A)).entries[0].message,'中文正文');
 const late=Buffer.concat([Buffer.from((line('test.app','valid')).repeat(1800)),Buffer.from([0xff]),Buffer.from('\n')]);
 const imperfect=await upload(library,'late.log.gz',gzipSync(late));assert.equal(imperfect.parsingStatus,'partial');assert.equal(imperfect.files.length,1);assert.ok(imperfect.files[0].replacementCharacters>0);assert.ok(imperfect.importWarnings.length);assert.equal(imperfect.files[0].count,1801);
}));
test('explicit text encoding is validated and retry can change it without touching the original',()=>fixture(async library=>{
 await assert.rejects(library.begin({name:'x.log',size:1,encoding:'arbitrary'},A),/编码/);
 const bytes=Buffer.from([0xd6,0xd0,0xce,0xc4,10]),packed=await upload(library,'gbk.gz',gzipSync(bytes),{encoding:'gb18030'});
 assert.equal(packed.files[0].encoding,'gb18030');assert.equal((await library.getLogs(packed.files[0].id,{},A)).entries[0].message,'中文');
 const retry=await library.retryPackage(packed.id,A,'utf-8');assert.ok(retry.files[0].replacementCharacters);assert.equal(retry.parsingStatus,'partial');
}));

test('GB18030 after a long ASCII prefix is detected from the whole GZ payload',()=>fixture(async library=>{
 const bytes=Buffer.concat([Buffer.from('prefix\n'.repeat(12000)),Buffer.from([0xd6,0xd0,0xce,0xc4,10])]);
 const packed=await upload(library,'late-gbk.gz',gzipSync(bytes));assert.equal(packed.parsingStatus,'complete');assert.equal(packed.files[0].encoding,'gb18030');assert.equal((await library.getLogs(packed.files[0].id,{offset:12000},A)).entries[0].message,'中文');
}));

test('larger text and archive admission uses 1 GiB / 2 GiB boundaries without allocating oversized payloads',()=>fixture(async library=>{
 assert.equal(TEXT_BYTES,1024**3);assert.equal(PACKAGE_BYTES,2*1024**3);assert.equal(EXPANDED_BYTES,8*1024**3);
 for(const [name,size] of [['large.log',TEXT_BYTES],['large.zip',PACKAGE_BYTES],['large.gz',PACKAGE_BYTES],['large.rar',PACKAGE_BYTES]]){const upload=await library.begin({name,size},A);assert.equal(upload.size,size);await library.abort(upload.id,A);}
 await assert.rejects(library.begin({name:'overflow.log',size:TEXT_BYTES+1},A),/1 GiB/);
 await assert.rejects(library.begin({name:'overflow.zip',size:PACKAGE_BYTES+1},A),/2 GiB/);
}));
