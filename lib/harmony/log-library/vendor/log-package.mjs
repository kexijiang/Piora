// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { inspectLogEncoding } from './log-encoding.mjs';
import { extractRar } from './log-rar.mjs';
import { mkdir, open, readdir, copyFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip, crc32 } from 'node:zlib';
import { join, resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import yauzl from 'yauzl';
import { TEXT_BYTES, PACKAGE_BYTES } from './log-storage.mjs';
import { EXPANDED_BYTES, MAX_PACKAGE_ENTRIES, expandedLimitLabel } from './log-limits.mjs';
export { PACKAGE_BYTES };
export const packageName = name => /\.(zip|gz|rar)$/i.test(name || '');
export const dictionaryName = name => /^hilog_dict[^/\\]*\.zip$/i.test(basename(name || ''));
const TOTAL_BYTES = EXPANDED_BYTES, MAX_ENTRIES = MAX_PACKAGE_ENTRIES;
export async function findHilogTool(configured) {
  const candidates = [configured, process.env.HILOGTOOL_PATH];
  for (const sdk of [process.env.DEVECO_SDK_HOME, process.env.OHOS_SDK_HOME, process.env.HOS_SDK_HOME, process.env.DEVECO_STUDIO_HOME].filter(Boolean)) {
    for (const suffix of ['', 'hms/toolchains', 'default/hms/toolchains', 'sdk/default/hms/toolchains']) candidates.push(join(sdk, suffix, process.platform === 'win32' ? 'hilogtool.exe' : 'hilogtool'));
  }
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) if (dir) candidates.push(join(dir, process.platform === 'win32' ? 'hilogtool.exe' : 'hilogtool'));
  for (const path of candidates.filter(Boolean)) if ((await stat(path).catch(() => undefined))?.isFile()) return resolve(path);
  return undefined;
}
function safeEntry(root, name) {
  if (!name || name.includes('\\') || /[<>:\x00-\x1f\"|?*]/.test(name) || /(^|\/)\.\.?(\/|$)/.test(name) || /^[A-Za-z]:/.test(name)) throw Error('压缩包内含不安全路径');
  if (name.split('/').some(part => part && (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i.test(part)))) throw Error('压缩包含 Windows 保留或歧义路径');
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('压缩包路径超出解包目录');
  return path;
}
async function textFile(path, encoding = 'auto') { return (await inspectLogEncoding(path, encoding)).text; }
async function filesBelow(root) {
  const values = [];
  async function visit(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isSymbolicLink()) throw Error('日志包不能包含符号链接'); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) { values.push(path); if (values.length > MAX_ENTRIES) throw Error('日志包文件数量超过 10000'); } } }
  await visit(root); return values;
}
function byteLimit(budget, maximum = TEXT_BYTES, expectedCRC) {
  let bytes = 0, crc = 0;
  return new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; budget.bytes += chunk.length; if (expectedCRC !== undefined) crc = crc32(chunk, crc); if (bytes > maximum || budget.bytes > TOTAL_BYTES) callback(Error(expandedLimitLabel)); else callback(null, chunk); }, flush(callback) { callback(expectedCRC !== undefined && crc !== expectedCRC ? Error('ZIP 文件 CRC 校验失败，原包保留') : undefined); } });
}
async function extractZip(source, destination, budget, signal) {
  const zip = await new Promise((yes, no) => yauzl.open(source, { lazyEntries: true, validateEntrySizes: true }, (error, value) => error ? no(error) : yes(value)));
  let entries = 0; const paths = [], seen = new Set();
  await new Promise((yes, no) => {
    const abort = () => fail(signal.reason || Error('已取消'));
    const fail = error => { signal.removeEventListener('abort', abort); zip.close(); no(error); };
    signal.addEventListener('abort', abort, { once: true }); zip.on('error', fail);
    zip.on('end', () => { signal.removeEventListener('abort', abort); yes(); });
    zip.on('entry', entry => { (async () => {
      signal.throwIfAborted(); if (++entries > MAX_ENTRIES) throw Error('压缩包文件数量超过 10000');
      const path = safeEntry(destination, entry.fileName), mode = entry.externalFileAttributes >>> 16;
      if ((mode & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1) throw Error('不支持链接或加密 ZIP');
      if (seen.has(path.toLocaleLowerCase())) throw Error('压缩包存在重复或大小写冲突路径'); seen.add(path.toLocaleLowerCase());
      if (/\/$/.test(entry.fileName)) { await mkdir(path, { recursive: true }); zip.readEntry(); return; }
      if (!/\.(txt|log|jsonl|json|gz)$/i.test(entry.fileName) && !dictionaryName(entry.fileName)) { zip.readEntry(); return; }
      if (entry.uncompressedSize > (packageName(entry.fileName) ? PACKAGE_BYTES : TEXT_BYTES) || budget.bytes + entry.uncompressedSize > TOTAL_BYTES) throw Error('压缩包声明的展开大小超过限制');
      await mkdir(dirname(path), { recursive: true });
      const stream = await new Promise((yes, no) => zip.openReadStream(entry, (error, stream) => error ? no(error) : yes(stream)));
      await pipeline(stream, byteLimit(budget, packageName(entry.fileName) ? PACKAGE_BYTES : TEXT_BYTES, entry.crc32), createWriteStream(path, { flags: 'wx' }), { signal }); paths.push(path); zip.readEntry();
    })().catch(fail); }); zip.readEntry();
  });
  return paths;
}
async function validateDictionary(source, root, budget, signal) {
  const zip = await new Promise((yes, no) => yauzl.open(source, { lazyEntries: true, validateEntrySizes: true }, (error, value) => error ? no(error) : yes(value)));
  let count = 0; const seen = new Set();
  await new Promise((yes, no) => {
    const fail = error => { zip.close(); no(error); };
    zip.on('error', fail); zip.on('end', yes);
    zip.on('entry', entry => { try { signal.throwIfAborted(); if (++count > MAX_ENTRIES) throw Error('字典条目超过 10000'); const path = safeEntry(root, entry.fileName); if (seen.has(path.toLocaleLowerCase())) throw Error('字典含重复路径'); seen.add(path.toLocaleLowerCase()); if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1) throw Error('字典不能包含链接或加密条目'); budget.bytes += entry.uncompressedSize; if (entry.uncompressedSize > TEXT_BYTES || budget.bytes > TOTAL_BYTES) throw Error('字典展开大小超过容量限制'); zip.readEntry(); } catch (error) { fail(error); } }); zip.readEntry();
  });
}
export async function runHilogTool(tool, args, signal, cwd) {
  return new Promise((yes, no) => {
    const child = spawn(tool, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal }); let output = '';
    const add = chunk => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { child.kill(); no(Error('hilogtool 解析超过 180 秒，请拆分日志包')); }, 180000); timer.unref();
    child.once('error', error => { clearTimeout(timer); no(error); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0) no(Error('hilogtool 退出码 ' + code + '：' + output.slice(-2000))); else yes(output); });
  });
}
export async function importPackage({ source, name, work, signal, dictionaries = [], toolPath, consume, progress = () => {}, runTool = runHilogTool, encoding = 'auto' }) {
  const budget = { bytes: 0 }, children = [], warnings = [], text = [], binary = [], dicts = [...dictionaries];
  let toolWork;
  await mkdir(work, { recursive: true });
  try {
    const paths = /\.zip$/i.test(name) ? await extractZip(source, join(work, 'extracted'), budget, signal) : /\.rar$/i.test(name) ? await extractRar(source, join(work, 'extracted'), budget, signal, { safeEntry, byteLimit, textBytes: TEXT_BYTES, packageBytes: PACKAGE_BYTES, totalBytes: TOTAL_BYTES, maxEntries: MAX_ENTRIES }) : [source];
    for (const path of paths) if (dictionaryName(path)) dicts.push(path);
    for (let i = 0; i < paths.length; i++) {
      signal.throwIfAborted(); const path = paths[i]; if (dictionaryName(path)) continue;
      const originalName = path === source ? name : relative(join(work, 'extracted'), path).replaceAll('\\', '/');
      progress({ phase: '解包', current: i + 1, total: paths.length });
      if (/\.gz$/i.test(originalName)) {
        const decoded = join(work, 'inflated', String(i) + '.log'); await mkdir(dirname(decoded), { recursive: true });
        try { await pipeline(createReadStream(path), createGunzip(), byteLimit(budget), createWriteStream(decoded), { signal }); }
        catch (error) { if (/限制|取消|abort/i.test(error.message)) throw error; warnings.push(originalName + '：无法解压，保留原包'); continue; }
        if (await textFile(decoded, encoding)) text.push({ path: decoded, name: originalName.replace(/\.gz$/i, '.log'), relativePath: originalName });
        else binary.push({ path, name: basename(originalName) });
      } else if (await textFile(path, encoding)) text.push({ path, name: basename(originalName), relativePath: originalName });
      else warnings.push(originalName + '：包含二进制内容，未强制当作文本；原厂 HiLog 请保留 .gz 与配套字典');
    }
    let parsingStatus = 'complete';
    if (binary.length) {
      const tool = await findHilogTool(toolPath);
      if (!dicts.length) { parsingStatus = 'needs-dictionary'; warnings.push('缺少配套 hilog_dict*.zip；原包已保留。将字典导入当前会话后点击重新解析。'); }
      else if (!tool && runTool === runHilogTool) { parsingStatus = 'needs-tool'; warnings.push('未找到 hilogtool；请在日志工作台配置本机工具路径后重新解析。'); }
      else {
        // Native SDK utilities can still have MAX_PATH-limited ZIP handling.
        // Keep only the decoder scratch in a short, owned temporary directory.
        toolWork = await mkdtemp(join(tmpdir(), 'dsh-hilog-'));
        const input = join(toolWork, 'input'), output = join(toolWork, 'output'); await mkdir(input, { recursive: true }); await mkdir(output, { recursive: true });
        for (const item of binary) await copyFile(item.path, join(input, item.name));
        progress({ phase: '解析 HiLog', current: 0, total: binary.length });
        let decoded = false;
        for (const [number, dict] of [...new Set(dicts)].slice(0, 16).entries()) {
          signal.throwIfAborted();
          await validateDictionary(dict, join(toolWork, 'dictionary-validation'), budget, signal);
          const localDict = join(toolWork, 'dict-' + number + '.zip'); await copyFile(dict, localDict);
          const quota = new AbortController(), combined = AbortSignal.any([signal, quota.signal]); let checking = false;
          const timer = setInterval(async () => { if (checking) return; checking = true; try { let size = 0; for (const file of await filesBelow(output)) { size += (await stat(file)).size; if (size + budget.bytes > TOTAL_BYTES || (await stat(file)).size > TEXT_BYTES) { quota.abort(Error('HiLog 解析产物超过容量限制')); break; } } } catch (error) { quota.abort(error); } finally { checking = false; } }, 500); timer.unref();
          let message; try { message = await runTool(tool, ['parse', '-i', relative(toolWork, input), '-o', relative(toolWork, output), '-d', basename(localDict)], combined, toolWork); combined.throwIfAborted(); } finally { clearInterval(timer); }
          const produced = await filesBelow(output); let bytes = 0;
          for (const file of produced) { bytes += (await stat(file)).size; if (bytes > TOTAL_BYTES) throw Error('HiLog 解析产物超过累计 8 GiB'); }
          if (produced.length) {
            for (const path of produced) if (/\.(txt|log|jsonl)$/i.test(path) || await textFile(path, encoding)) text.push({ path, name: basename(path), relativePath: relative(output, path).replaceAll('\\', '/'), decoded: true });
            decoded = true; if (/unknown log|OpenUuidFile fail|\b300\b/i.test(message)) { parsingStatus = 'partial'; warnings.push('部分日志与字典不匹配，请核对配套字典；已保留可解析结果。'); } break;
          }
        }
        if (!decoded) { parsingStatus = 'needs-dictionary'; warnings.push('未生成可读日志，可能是字典或工具版本不匹配；原包保留，可补充后重新解析。'); }
      }
    }
    for (let i = 0; i < text.length; i++) {
      signal.throwIfAborted(); progress({ phase: '导入正文', current: i + 1, total: text.length });
      try { const child = await consume(text[i]); children.push(child); if (child.replacementCharacters) { warnings.push(text[i].name + '：部分字节无法按所选编码还原，可读副本使用替换字符；原始文件保留。'); parsingStatus = 'partial'; } } catch (error) { signal.throwIfAborted(); warnings.push(text[i].name + '：' + error.message); parsingStatus = 'partial'; }
    }
    if (!children.length && !binary.length) { parsingStatus = 'partial'; warnings.push('包内没有可识别的日志文本，原包已保留。'); }
    return { children, warnings, parsingStatus };
  } finally {
    if (toolWork) { const rel = relative(tmpdir(), toolWork); if (rel.startsWith('dsh-hilog-') && !rel.includes('..') && !isAbsolute(rel)) await rm(toolWork, { recursive: true, force: true }); }
    const rel = relative(dirname(work), work); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) await rm(work, { recursive: true, force: true });
  }
}
