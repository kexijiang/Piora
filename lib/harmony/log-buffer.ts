// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
export interface BufferedLog { id: number; raw: string; message: string; tag?: string; domain?: string }
export const LIVE_LOG_ROWS = 100_000;
export const LIVE_LOG_BYTES = 128 * 1024 * 1024;
const payloadSize = (entry: BufferedLog) => 2 * (entry.raw.length + entry.message.length + (entry.tag?.length ?? 0) + (entry.domain?.length ?? 0));

/** Incremental bounded ring. Incoming batches never scan or copy retained history. */
export class LogRingBuffer<T extends BufferedLog> {
  private slots: Array<T | undefined>;
  private head = 0;
  length = 0;
  bytes = 0;
  constructor(readonly maxRows = LIVE_LOG_ROWS, readonly maxBytes = LIVE_LOG_BYTES) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isFinite(maxBytes) || maxBytes < 1) throw Error('Invalid log buffer budget');
    this.slots = new Array(maxRows);
  }
  clear() { this.slots = new Array(this.maxRows); this.head = 0; this.length = 0; this.bytes = 0; }
  push(added: readonly T[]) {
    let removed = 0;
    const evict = () => { const entry = this.slots[this.head]!; this.bytes -= payloadSize(entry); this.slots[this.head] = undefined; this.head = (this.head + 1) % this.maxRows; this.length--; removed++; };
    for (const entry of added) {
      if (this.length === this.maxRows) evict();
      this.slots[(this.head + this.length) % this.maxRows] = entry; this.length++; this.bytes += payloadSize(entry);
      while (this.length && this.bytes > this.maxBytes) evict();
    }
    return { removed, bytes: this.bytes, count: this.length };
  }
  snapshot(): T[] {
    return Array.from({ length: this.length }, (_, index) => this.slots[(this.head + index) % this.maxRows]!);
  }
}
/** Limits stored text payload and row count; DOM virtualization has its own bound. */
export function retainLogBatch<T extends BufferedLog>(previous: T[], added: T[], maxRows = 10000, maxBytes = 8 * 1024 * 1024) {
  const entries = previous.concat(added); let bytes = 0;
  const size = (entry: T) => 2 * (entry.raw.length + entry.message.length + (entry.tag?.length ?? 0) + (entry.domain?.length ?? 0));
  let start = Math.max(0, entries.length - maxRows);
  for (let index = start; index < entries.length; index++) bytes += size(entries[index]);
  while (start < entries.length && bytes > maxBytes) bytes -= size(entries[start++]);
  return { entries: entries.slice(start), removed: start, bytes };
}
