// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
const enabled = value => value === true || value === 'true';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = value => value !== undefined && /[\p{L}\p{N}_]/u.test(value);
function needsWholeText(text, dotMatchesNewline) {
  if (dotMatchesNewline || /[\r\n]/.test(text)) return true;
  // Conservative whitelist: any escape whose newline behavior is not proven
  // local takes the bounded whole-text path (\W, \D, codepoints, properties,
  // backreferences, etc.). Never report a complete zero from a guessed path.
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '\\') { if (!'dwbBtfv\\.*+?()[]{}|^$/-'.includes(text[++at] || '\0')) return true; }
    else if (text[at] === '^' || text[at] === '$' || text[at] === '[' && text[at + 1] === '^') return true;
  }
  return false;
}

export function decodeExtendedSearch(value) {
  return value.replace(/\\(\\|n|r|t|0|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, (_, code) => {
    if (code === '\\') return '\\';
    if (code[0] === 'x' || code[0] === 'u') return String.fromCharCode(parseInt(code.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', 0: '\0' }[code];
  });
}
export function wildcardMatch(input, pattern) {
  input = input.toLocaleLowerCase(); pattern = (pattern === '*.*' ? '*' : pattern).toLocaleLowerCase();
  let i = 0, p = 0, star = -1, restart = 0;
  while (i < input.length) {
    if (pattern[p] === '?' || pattern[p] === input[i]) { i++; p++; }
    else if (pattern[p] === '*') { star = p++; restart = i; }
    else if (star >= 0) { p = star + 1; i = ++restart; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function compileSessionSearch(options = {}) {
  const query = String(options.query ?? '');
  if (!query.length) throw Error('请输入跨文件查找关键词');
  if (query.length > 2048) throw Error('查找内容最多 2048 字符');
  const mode = options.mode || (enabled(options.regex) ? 'regex' : 'normal');
  if (!['normal', 'extended', 'regex'].includes(mode)) throw Error('无效查找模式');
  const filePattern = String(options.filePattern || '*.*').trim();
  if (filePattern.length > 1024) throw Error('文件筛选最多 1024 字符');
  const patterns = filePattern.split(/[;\s]+/).filter(Boolean);
  if (patterns.length > 64) throw Error('文件筛选最多 64 个通配符');
  const include = patterns.filter(pattern => !pattern.startsWith('!'));
  const exclude = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));
  const text = mode === 'extended' ? decodeExtendedSearch(query) : query;
  if (!text.length) throw Error('查找内容不能为空');
  const wholeWord = enabled(options.wholeWord), caseSensitive = enabled(options.caseSensitive), dotMatchesNewline = enabled(options.dotMatchesNewline);
  // Only the dedicated, timed worker executes this expression. UI highlighting
  // consumes returned ranges; the ordinary live-log regex dialect is unchanged.
  let expression;
  try { expression = new RegExp(mode === 'regex' ? text : escape(text), 'gmu' + (caseSensitive ? '' : 'i') + (dotMatchesNewline ? 's' : '')); }
  catch (error) { throw Error('正则表达式无效：' + error.message); }
  const multiline = /[\r\n]/.test(text) || mode === 'regex' && needsWholeText(text, dotMatchesNewline);
  return {
    key: JSON.stringify({ query, mode, wholeWord, caseSensitive, dotMatchesNewline }), multiline,
    acceptsFile(name) { return (!include.length || include.some(pattern => wildcardMatch(name, pattern))) && !exclude.some(pattern => wildcardMatch(name, pattern)); },
    *matches(input) {
      expression.lastIndex = 0;
      let match;
      while ((match = expression.exec(input))) {
        const start = match.index, end = start + match[0].length;
        const before = start ? [...input.slice(Math.max(0, start - 2), start)].at(-1) : undefined;
        const after = end < input.length ? String.fromCodePoint(input.codePointAt(end)) : undefined;
        if (!wholeWord || !word(before) && !word(after)) yield [start, end];
        if (!match[0].length) expression.lastIndex += input.codePointAt(expression.lastIndex) > 0xffff ? 2 : 1;
      }
    },
    scan(input, maximumRanges = 200) {
      let count = 0; const ranges = [];
      for (const range of this.matches(input)) { count++; if (ranges.length < maximumRanges) ranges.push(range); }
      return { count, ranges, rangeTruncated: count > ranges.length };
    },
  };
}
