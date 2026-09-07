export function buildVirtualOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate: number): number[] {
  const offsets = [0];
  for (const key of keys) offsets.push(offsets[offsets.length - 1] + (heights.get(key) ?? estimate));
  return offsets;
}

export function virtualIndexAt(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function virtualRange(offsets: readonly number[], top: number, height: number, overscan = 6) {
  const count = offsets.length - 1;
  if (!count || top > offsets[count] + height || top + height < -height) return { start: 0, end: 0 };
  const start = Math.max(0, virtualIndexAt(offsets, top) - overscan);
  const end = Math.min(count, virtualIndexAt(offsets, top + height) + overscan + 1);
  return { start, end };
}
