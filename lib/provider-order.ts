/** Keep models within each channel in their existing order; new channels go last. */
export function orderByProvider<T>(items: readonly T[], order: readonly string[], provider: (item: T) => string): T[] {
  const ids = [...new Set([...order, ...items.map(provider)])];
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((a, b) => rank.get(provider(a))! - rank.get(provider(b))!);
}

export function moveProvider(order: readonly string[], from: string, to: string): string[] {
  const result = [...order];
  const start = result.indexOf(from), end = result.indexOf(to);
  if (start < 0 || end < 0 || start === end) return result;
  result.splice(start, 1);
  result.splice(end, 0, from);
  return result;
}
