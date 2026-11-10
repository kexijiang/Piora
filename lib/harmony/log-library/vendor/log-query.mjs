// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
// Browser-safe query helpers. Keep the same rules in UI and AI/server requests.
export const logStatusLabels = { disabled: '未启用', unresolved: '未识别日志目标', starting: '正在连接日志', capturing: '正在采集', captured: '已采集', empty: '已连接，未收到目标日志', unconfirmed: '未确认日志流就绪', failed: '采集失败', partial: '采集不完整' };
export const severity = { debug: 0, info: 1, unknown: 1, warn: 2, error: 3, fatal: 4 };
export const regexHelp = '支持字符类、锚点、分支和单个量词；量词后仍有内容时，分支需以 ^ 开头。不支持分组、回溯引用或同一分支多个量词。';
const enabled = value => value === true || value === 'true';

export function compilePattern(value = '', { regex = false, caseSensitive = false } = {}) {
  const text = String(value);
  if (text.length > 256) throw Error('筛选或查找内容最多 256 字符');
  if (!text) return undefined;
  if (!enabled(regex)) {
    const needle = enabled(caseSensitive) ? text : text.toLocaleLowerCase();
    return { test: input => (enabled(caseSensitive) ? String(input) : String(input).toLocaleLowerCase()).includes(needle), ranges(input) {
      const haystack = enabled(caseSensitive) ? String(input) : String(input).toLocaleLowerCase(), ranges = [];
      for (let i = haystack.indexOf(needle); i >= 0 && ranges.length < 200; i = haystack.indexOf(needle, i + Math.max(1, needle.length))) ranges.push([i, i + needle.length]);
      return ranges;
    } };
  }
  // Deliberately bounded subset of JS regex: reject the constructs that make
  // synchronous regex matching unbounded. One quantifier per branch, no groups.
  let inClass = false, escaped = false, quantified = 0, branchStart = 0, repeatEnd;
  const checkBranch = end => { if (repeatEnd !== undefined && text.slice(repeatEnd, end).replace(/\$$/, '') && text[branchStart] !== '^') throw Error('量词后仍有内容时，请用 ^ 锚定分支，例如 ^.*error'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { if (!inClass && /[1-9k]/.test(c)) throw Error('不支持正则回溯引用'); escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (c === '(' || c === ')') throw Error('为避免回溯卡顿，不支持正则分组或环视');
    if (c === '|') { checkBranch(i); quantified = 0; repeatEnd = undefined; branchStart = i + 1; continue; }
    if ('*+?'.includes(c)) { if (++quantified > 1) throw Error('每个正则分支最多一个量词'); repeatEnd = i + 1; }
    if (c === '{') {
      const bound = text.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
      if (!bound || Number(bound[1]) > 100 || bound[2] === '' || bound[2] && Number(bound[2]) > 100) throw Error('正则重复范围必须为 0～100 的有限范围');
      if (++quantified > 1) throw Error('每个正则分支最多一个量词');
      i += bound[0].length - 1;
      repeatEnd = i + 1;
    }
  }
  checkBranch(text.length);
  let expression;
  try { expression = new RegExp(text, enabled(caseSensitive) ? 'u' : 'iu'); } catch (error) { throw Error('正则表达式无效：' + error.message); }
  return { test: input => expression.test(String(input).slice(0, 16384)), ranges(input) {
    const re = new RegExp(expression.source, expression.flags + 'g'), ranges = [], bounded = String(input).slice(0, 16384);
    let match; while ((match = re.exec(bounded)) && ranges.length < 200) { if (match[0].length) ranges.push([match.index, match.index + match[0].length]); else re.lastIndex++; }
    return ranges;
  } };
}

export function normalizeLog(entry) {
  const originalTag = String(entry.tag || '');
  const parsed = originalTag.match(/^([A-Z]?[0-9A-Fa-f]{4,8})\/([^/]+)\/(.+)$/);
  const process = entry.process ?? parsed?.[2] ?? '';
  const explicit = entry.bundle || entry.bundleName || entry.appBundle || '';
  const bundle = String(explicit || (/^[A-Za-z][\w]*(?:\.[\w]+)+(?:[:][\w.]+)?$/.test(process) ? process.split(':')[0] : ''));
  return { ...entry, bundle, domain: entry.domain ?? parsed?.[1] ?? '', process, tag: parsed?.[3] ?? originalTag, level: Object.hasOwn(severity, entry.level) ? entry.level : 'unknown' };
}

export function compileLogQuery(options = {}) {
  if (options.bundle !== undefined && (typeof options.bundle !== 'string' || options.bundle.length > 256)) throw Error('包名过滤参数无效');
  const lineFrom = options.lineFrom === undefined || options.lineFrom === '' ? undefined : Number(options.lineFrom), lineUntil = options.lineUntil === undefined || options.lineUntil === '' ? undefined : Number(options.lineUntil);
  if (lineFrom !== undefined && (!Number.isSafeInteger(lineFrom) || lineFrom < 1) || lineUntil !== undefined && (!Number.isSafeInteger(lineUntil) || lineUntil < 1) || lineFrom !== undefined && lineUntil !== undefined && lineFrom > lineUntil) throw Error('原文件行号范围无效');
  if (options.level && !Object.hasOwn(severity, options.level)) throw Error('日志级别无效');
  const from = options.from ? Date.parse(options.from) : undefined, until = options.until ? Date.parse(options.until) : undefined;
  if (options.from && !Number.isFinite(from) || options.until && !Number.isFinite(until) || from !== undefined && until !== undefined && from > until) throw Error('日志时间范围无效');
  const fields = ['tag', 'domain', 'pid', 'tid'];
  const patterns = Object.fromEntries(['query', ...fields].map(field => [field, compilePattern(options[field] ?? '', options)]));
  return entry => {
    if (lineFrom !== undefined && (!Number.isSafeInteger(entry.sourceLine) || entry.sourceLine < lineFrom) || lineUntil !== undefined && (!Number.isSafeInteger(entry.sourceLine) || entry.sourceLine > lineUntil)) return false;
    const e = normalizeLog(entry), at = Date.parse(e.capturedAt);
    if (options.bundle && (options.bundle === '__unknown__' ? !!e.bundle : e.bundle !== options.bundle)) return false;
    if (options.level && severity[e.level] < severity[options.level]) return false;
    if (from !== undefined && (!Number.isFinite(at) || at < from) || until !== undefined && (!Number.isFinite(at) || at > until)) return false;
    if (fields.some(field => patterns[field] && !patterns[field].test(e[field] ?? ''))) return false;
    return !patterns.query || patterns.query.test(`${e.timestamp || ''} ${e.pid ?? ''} ${e.tid ?? ''} ${e.domain} ${e.process} ${e.tag} ${e.message || ''}`);
  };
}

export function validatePage(options = {}) {
  const offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 500);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error('日志分页参数无效：offset≥0，limit 为 1～1000');
  return { offset, limit };
}

export function publicLog(entry, maximum = 2000) {
  const e = normalizeLog(entry);
  const message = String(e.message || '');
  return { timestamp: e.timestamp, capturedAt: e.capturedAt, sourceLine: e.sourceLine, pid: e.pid, tid: e.tid, domain: e.domain, process: e.process, bundle: e.bundle, level: e.level, tag: e.tag, raw: maximum > 2000 ? String(e.raw || '').slice(0, maximum) : undefined, message: message.slice(0, maximum), messageTruncated: message.length > maximum, messageLength: message.length };
}
