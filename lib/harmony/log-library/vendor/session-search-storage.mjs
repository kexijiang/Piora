// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat, lstat, rename, rm, open, readdir, utimes } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compileSessionSearch } from './session-search.mjs';
import { validatePage } from './log-query.mjs';
import { redactLog } from './logs.mjs';

const PAGE_BYTES = 1024 ** 2, LINE_CHARS = 8192, MULTILINE_CHARS = 8 * 1024 ** 2;
const enabled = value => value === true || value === 'true';
async function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fd.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw Error('查找索引写入中断');
    offset += bytesWritten;
  }
}
async function trimSearchCaches(directory, keep) {
  const caches = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.search\.bin\.json$/.test(name)) continue;
    const path = join(directory, name), info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const data = path.slice(0, -5), dataInfo = await lstat(data).catch(() => undefined);
    caches.push({ path, data, size: info.size + (dataInfo?.isFile() ? dataInfo.size : 0), time: info.mtimeMs });
  }
  caches.sort((a, b) => Number(b.data === keep) - Number(a.data === keep) || b.time - a.time);
  let bytes = 0;
  for (let at = 0; at < caches.length; at++) {
    const cache = caches[at]; bytes += cache.size;
    if (at >= 4 || bytes > 64 * 1024 ** 2 && cache.data !== keep) {
      await rm(cache.path, { force: true }); await rm(cache.data, { force: true });
    }
  }
}
function visibleRange(start, end, line) {
  const length = line.end - line.start;
  return [Math.max(0, Math.min(length, start - line.start)), Math.max(0, Math.min(length, end - line.start))];
}
async function* sourceLines(directory) {
  const metaPath = join(directory, 'library.json');
  const info = await lstat(metaPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 ** 2) throw Error('日志元数据无效');
  const metadata = JSON.parse(await readFile(metaPath, 'utf8'));
  const source = join(directory, metadata.sourceCompression === 'gzip' ? 'source.log.gz' : 'source.log');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw Error('日志原文不是普通文件');
  const input = createReadStream(source, { highWaterMark: 65536 });
  const stream = metadata.sourceCompression === 'gzip' ? input.pipe(createGunzip()) : input;
  const decoder = new TextDecoder(metadata.encoding || 'utf-8');
  let carry = '', truncated = false, sourceLine = 0, last = '', ended = false;
  function append(part) { last = part.at(-1) ?? last; if (carry.length + part.length > LINE_CHARS + 1) truncated = true; carry += part.slice(0, Math.max(0, LINE_CHARS + 1 - carry.length)); }
  function* accept(text) {
    let start = 0;
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', start)) {
      append(text.slice(start, at));
      const eol = last === '\r' ? '\r\n' : '\n';
      const raw = carry.replace(/\r$/, '');
      yield { sourceLine: ++sourceLine, text: redactLog(raw.slice(0, LINE_CHARS)), eol, truncated: truncated || raw.length > LINE_CHARS };
      carry = ''; truncated = false; last = ''; start = at + 1; ended = true;
    }
    const remainder = text.slice(start); if (remainder.length) { append(remainder); ended = false; }
  }
  try {
    for await (const bytes of stream) yield* accept(decoder.decode(bytes, { stream: true }));
    yield* accept(decoder.decode());
    if (carry || truncated || ended) yield { sourceLine: ++sourceLine, text: redactLog(carry.slice(0, LINE_CHARS)), eol: '', truncated: truncated || carry.length > LINE_CHARS };
  } finally { stream.destroy(); input.destroy(); }
}
async function multilineText(directory) {
  const parts = [], lines = []; let length = 0, truncatedLines = 0;
  for await (const row of sourceLines(directory)) {
    if (row.truncated) throw Error('此文件含超过 8192 字符的长行，无法完整执行跨行搜索；未将截断位置当作真实换行');
    length += row.text.length + row.eol.length;
    if (length > MULTILINE_CHARS || lines.length >= 500000) throw Error('跨行搜索每份最多 8,388,608 字符 / 500000 行；请缩小文件范围，普通逐行查找不受此限制');
    lines.push({ sourceLine: row.sourceLine, start: length - row.text.length - row.eol.length, end: length - row.eol.length, truncated: row.truncated });
    parts.push(row.text + row.eol); if (row.truncated) truncatedLines++;
  }
  return { text: parts.join(''), lines, truncatedLines };
}
function* multilineRows(data, matcher) {
  let at = 0, current;
  for (const [start, end] of matcher.matches(data.text)) {
    while (at + 1 < data.lines.length && data.lines[at + 1].start <= start) at++;
    const line = data.lines[at]; if (!line) continue;
    if (current?.sourceLine !== line.sourceLine) { if (current) yield current; current = { sourceLine: line.sourceLine, text: data.text.slice(line.start, line.end), eol: '', truncated: line.truncated, column: start - line.start + 1, ranges: [], count: 0 }; }
    current.count++;
    // At most 200 highlight ranges are retained even for a long repeated line.
    if (current.ranges.length < 200) current.ranges.push(visibleRange(start, end, line));
  }
  if (current) yield current;
}
async function fileIndex(file, matcher, searchJobId) {
  const directory = join(file.directory, 'queries'); await mkdir(directory, { recursive: true });
  const sourceMetadata = JSON.parse(await readFile(join(file.directory, 'library.json'), 'utf8'));
  const sourceInfo = await stat(join(file.directory, sourceMetadata.sourceCompression === 'gzip' ? 'source.log.gz' : 'source.log'));
  const key = createHash('sha256').update('session-search-source-v3:' + matcher.key + ':' + sourceInfo.size + ':' + sourceInfo.mtimeMs).digest('hex');
  const path = join(directory, key + '.search.bin'), metaPath = path + '.json';
  try {
    const value = JSON.parse(await readFile(metaPath, 'utf8'));
    if (value.version === 1 && value.multiline === matcher.multiline && (matcher.multiline || (await stat(path)).size === value.lines * 8)) {
      const now = new Date(); await utimes(metaPath, now, now).catch(() => {});
      await trimSearchCaches(directory, path); return { ...value, path };
    }
  } catch { /* Missing/incomplete caches are rebuilt from original bytes. */ }
  let total = 0, lines = 0, hits = 0, truncatedLines = 0;
  if (matcher.multiline) {
    const data = await multilineText(file.directory); total = data.lines.length; truncatedLines = data.truncatedLines;
    for (const row of multilineRows(data, matcher)) { lines++; hits += row.count; }
  } else {
    const temporary = path + '.' + searchJobId + '.tmp', fd = await open(temporary, 'wx');
    const buffer = Buffer.alloc(65536); let used = 0;
    try {
      for await (const row of sourceLines(file.directory)) {
        total++; if (row.truncated) { truncatedLines++; continue; }
        const count = matcher.scan(row.text, 0).count;
        if (!count) continue;
        if ((lines + 1) * 8 > 64 * 1024 ** 2) throw Error('匹配索引超过 64 MiB，请缩小查找范围');
        lines++; hits += count; buffer.writeUInt32LE(row.sourceLine, used); buffer.writeUInt32LE(count, used + 4); used += 8;
        if (used === buffer.length) { await writeAll(fd, buffer); used = 0; }
      }
      if (used) await writeAll(fd, buffer.subarray(0, used));
      await fd.close(); await rename(temporary, path);
    } finally { await fd.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  const value = { version: 1, multiline: matcher.multiline, total, lines, hits, truncatedLines };
  const tempMeta = metaPath + '.' + searchJobId + '.tmp';
  await writeFile(tempMeta, JSON.stringify(value)); await rename(tempMeta, metaPath);
  await trimSearchCaches(directory, path);
  return { ...value, path };
}
async function* indexRows(path) {
  for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) {
    if (chunk.length % 8) throw Error('查找索引不完整，请重新查找');
    for (let at = 0; at < chunk.length; at += 8) yield { sourceLine: chunk.readUInt32LE(at), count: chunk.readUInt32LE(at + 4) };
  }
}
async function* filePage(file, index, matcher, localOffset, limit, oneEntryPerLine) {
  if (matcher.multiline) {
    const data = await multilineText(file.directory); let cursor = 0, emitted = 0;
    if (!oneEntryPerLine) {
      const counts = new Uint32Array(data.lines.length); let at = 0;
      for (const [start] of matcher.matches(data.text)) { while (at + 1 < data.lines.length && data.lines[at + 1].start <= start) at++; counts[at]++; }
      at = 0;
      for (const [start, end] of matcher.matches(data.text)) {
        while (at + 1 < data.lines.length && data.lines[at + 1].start <= start) at++;
        if (cursor++ < localOffset) continue;
        const line = data.lines[at]; if (!line) continue;
        yield { sourceLine: line.sourceLine, text: data.text.slice(line.start, line.end), truncated: false, ranges: [visibleRange(start, end, line)], occurrenceIndex: cursor - 1, column: start - line.start + 1, hitCount: counts[at], rangeTruncated: false };
        if (++emitted >= limit) return;
      }
      return;
    }
    for (const row of multilineRows(data, matcher)) {
      const units = oneEntryPerLine ? 1 : row.count;
      if (cursor + units <= localOffset) { cursor += units; continue; }
      const ranges = oneEntryPerLine ? [row.ranges] : row.ranges.map(range => [range]);
      for (let at = 0; at < ranges.length; at++) {
        if (cursor + at < localOffset) continue;
        yield { ...row, ranges: ranges[at], occurrenceIndex: at, column: row.column, hitCount: row.count, rangeTruncated: row.count > row.ranges.length };
        if (++emitted >= limit) return;
      }
      cursor += units;
    }
    return;
  }
  const wanted = new Map(); let cursor = 0, needed = limit;
  for await (const row of indexRows(index.path)) {
    const units = oneEntryPerLine ? 1 : row.count;
    if (cursor + units <= localOffset) { cursor += units; continue; }
    const skip = Math.max(0, localOffset - cursor), take = Math.min(units - skip, needed);
    wanted.set(row.sourceLine, { ...row, skip, take }); needed -= take; cursor += units;
    if (!needed) break;
  }
  if (!wanted.size) return;
  for await (const row of sourceLines(file.directory)) {
    const target = wanted.get(row.sourceLine); if (!target) continue;
    if (oneEntryPerLine) { const match = matcher.scan(row.text); yield { ...row, ranges: match.ranges, hitCount: match.count, rangeTruncated: match.rangeTruncated, occurrenceIndex: 0, column: (match.ranges[0]?.[0] ?? 0) + 1 }; }
    else {
      let ordinal = 0, emitted = 0;
      for (const range of matcher.matches(row.text)) { if (ordinal++ < target.skip) continue; yield { ...row, ranges: [range], hitCount: target.count, occurrenceIndex: ordinal - 1, column: range[0] + 1 }; if (++emitted === target.take) break; }
    }
    wanted.delete(row.sourceLine); if (!wanted.size) return;
  }
  throw Error('日志内容或匹配索引已变化，请重新导入后查找');
}
export async function sessionSearchPage({ files, options = {}, searchJobId = randomUUID() }, progress = () => {}) {
  const { offset, limit } = validatePage(options), matcher = compileSessionSearch(options);
  // Existing callers retain line-based pagination; the Notepad-style UI opts
  // into per-occurrence results explicitly so old integrations do not skip rows.
  const oneEntryPerLine = options.oneEntryPerLine === undefined || enabled(options.oneEntryPerLine);
  const indexes = [], errors = [], fileMatches = []; let total = 0, filteredTotal = 0, totalHits = 0, errorCount = 0;
  const failure = (file, error) => { errorCount++; if (errors.length < 100) errors.push({ id: String(file.id).slice(0, 256), name: String(file.name).slice(0, 256), error: String(error.message).slice(0, 512) }); };
  for (const file of files) {
    try {
      const index = await fileIndex(file, matcher, searchJobId); indexes.push({ file, index }); total += index.total; filteredTotal += index.lines; totalHits += index.hits;
      if (index.lines && fileMatches.length < 1000) fileMatches.push({ id: file.id, name: file.name, count: index.lines, hits: index.hits });
      if (index.truncatedLines) failure(file, Error(`${index.truncatedLines} 条超过 8192 字符的行未参与搜索，结果不完整；原始文件仍保留`));
    } catch (error) { failure(file, error); }
    progress({ phase: '跨文件查找', files: indexes.length, matches: totalHits });
  }
  const matchedFiles = indexes.filter(value => value.index.lines).length, resultTotal = oneEntryPerLine ? filteredTotal : totalHits;
  const result = { entries: [], total, filteredTotal, totalHits, resultTotal, matchedFiles, searchedFiles: files.length, fileMatches, summaryTruncated: matchedFiles > fileMatches.length, errors, errorCount, complete: errorCount === 0, offset, nextOffset: null, pageByteLimit: PAGE_BYTES };
  while (Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES / 2 && fileMatches.length) { fileMatches.pop(); result.summaryTruncated = true; }
  let bytes = Buffer.byteLength(JSON.stringify(result)) + 128, skipped = 0, pageFull = false, nextCursor = offset;
  const entryCursors = [];
  for (const { file, index } of indexes) {
    const units = oneEntryPerLine ? index.lines : index.hits;
    if (skipped + units <= offset) { skipped += units; continue; }
    const localOffset = Math.max(0, offset - skipped); let read = 0;
    try {
      for await (const row of filePage(file, index, matcher, localOffset, limit - result.entries.length, oneEntryPerLine)) {
        const entry = { fileId: file.id, fileName: file.name, sourceLine: row.sourceLine, message: row.text, messageTruncated: !!row.truncated, ranges: row.ranges, hitCount: row.hitCount, rangeTruncated: !!row.rangeTruncated, occurrenceIndex: row.occurrenceIndex, column: row.column };
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (result.entries.length && (result.entries.length >= limit || bytes + size > PAGE_BYTES)) { pageFull = true; break; }
        entryCursors.push(skipped + localOffset + read++); result.entries.push(entry); bytes += size; nextCursor = skipped + localOffset + read;
      }
    } catch (error) { failure(file, error); result.complete = false; result.errorCount = errorCount; nextCursor = skipped + units; }
    skipped += units; if (pageFull || result.entries.length >= limit) break;
  }
  result.nextOffset = nextCursor < resultTotal ? nextCursor : null;
  while (Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES && result.entries.length) { result.entries.pop(); result.nextOffset = entryCursors.pop(); }
  if (!result.entries.length && result.nextOffset !== null && result.nextOffset <= offset) { result.nextOffset = null; result.complete = false; }
  return result;
}
