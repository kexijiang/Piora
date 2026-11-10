// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
/** Bounded regular-expression subset: no groups/backreferences/lookarounds and
 * at most one repetition; non-terminal repetitions must be start-anchored. */
export function validateLogRegex(query: string): string | null {
  if (query.length > 256) return "正则表达式最多 256 个字符";
  const source = query.replace(/\\./g, "_").replace(/\[[^\]]*\]/g, "_");
  if (/[()]/.test(source) || /\\[1-9]|\\k</.test(query)) return "为保持日志响应，正则不支持分组、环视或反向引用";
  if ((source.match(/[*+?]|\{\d+(?:,\d*)?\}/g) ?? []).length > 1) return "正则最多包含一个重复量词";
  if (!source.startsWith("^") && /(?:[*+?]|\{\d+(?:,\d*)?\})[^$]/.test(source)) return "重复量词后有其它内容时，请使用 ^ 锚定起点（例如 ^.*error）";
  if (/\{\d{5,}/.test(source)) return "正则重复次数过大";
  return null;
}

export function createLogMatcher(query: string, regex: boolean, caseSensitive = false): { matches: (text: string) => boolean; error: string | null } {
  if (!query) return { matches: () => true, error: null };
  if (!regex) { const needle = caseSensitive ? query : query.toLocaleLowerCase(); return { matches: (text) => (caseSensitive ? text : text.toLocaleLowerCase()).includes(needle), error: null }; }
  const unsafe = validateLogRegex(query);
  if (unsafe) return { matches: () => false, error: unsafe };
  try {
    const pattern = new RegExp(query, caseSensitive ? "" : "i");
    return { matches: (text) => pattern.test(text.slice(0, 65536)), error: null };
  } catch (error) { return { matches: () => false, error: error instanceof Error ? error.message : String(error) }; }
}

export function logHighlightParts(text: string, query: string, regex = false, caseSensitive = false): { text: string; match: boolean }[] {
  if (!query || (regex && validateLogRegex(query))) return [{ text, match: false }];
  try {
    const pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
    const parts: { text: string; match: boolean }[] = []; let offset = 0, found: RegExpExecArray | null;
    while ((found = pattern.exec(text)) && parts.length < 128) {
      if (!found[0].length) break;
      if (found.index > offset) parts.push({ text: text.slice(offset, found.index), match: false });
      parts.push({ text: found[0], match: true }); offset = found.index + found[0].length;
    }
    if (offset < text.length) parts.push({ text: text.slice(offset), match: false });
    return parts.length ? parts : [{ text, match: false }];
  } catch { return [{ text, match: false }]; }
}

/** HiLog supplies month/day and device-clock time, without year or timezone. */
export function createLogTimeRange(start: string, end: string): { matches: (timestamp?: string) => boolean; error: string | null } {
  const parse = (value: string) => {
    const match = value.trim().match(/^(?:(\d{2})-(\d{2})\s+)?(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/);
    if (!match) return null;
    const month = Number(match[1]), day = Number(match[2]), hour = Number(match[3]), minute = Number(match[4]), second = Number(match[5] ?? 0);
    if (hour > 23 || minute > 59 || second > 59 || (match[1] && (month < 1 || month > 12 || day < 1 || day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]))) return null;
    const milliseconds = Number((match[6]?.slice(1) ?? "").padEnd(3, "0").slice(0, 3));
    return { dated: Boolean(match[1]), value: ((match[1] ? (month * 32 + day) * 86400 : 0) + hour * 3600 + minute * 60 + second) * 1000 + milliseconds,
      precision: match[6] ? 0 : match[5] ? 999 : 59999 };
  };
  const from = start.trim() ? parse(start) : null, to = end.trim() ? parse(end) : null;
  if ((start.trim() && !from) || (end.trim() && !to) || (from && to && from.dated !== to.dated)) {
    return { matches: () => false, error: "format" };
  }
  if (!from && !to) return { matches: () => true, error: null };
  const dated = (from ?? to)!.dated;
  const minimum = from?.value, maximum = to ? to.value + to.precision : undefined;
  return { error: null, matches: timestamp => {
    if (!timestamp) return false;
    const entry = parse(dated ? timestamp : timestamp.replace(/^\d{2}-\d{2}\s+/, ""));
    if (!entry || entry.dated !== dated) return false;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) return entry.value >= minimum || entry.value <= maximum;
    return (minimum === undefined || entry.value >= minimum) && (maximum === undefined || entry.value <= maximum);
  } };
}
