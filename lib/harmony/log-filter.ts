export function createLogMatcher(query: string, regex: boolean): { matches: (text: string) => boolean; error: string | null } {
  if (!query) return { matches: () => true, error: null };
  if (!regex) { const needle = query.toLocaleLowerCase(); return { matches: (text) => text.toLocaleLowerCase().includes(needle), error: null }; }
  try {
    const pattern = new RegExp(query, "i");
    return { matches: (text) => pattern.test(text), error: null };
  } catch (error) { return { matches: () => false, error: error instanceof Error ? error.message : String(error) }; }
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
