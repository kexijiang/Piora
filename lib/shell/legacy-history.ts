const PREFIX = "piora-terminal-history-v1:";
type HistoryStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem">;
interface LegacyEntry { cwd: string; command: string }

export async function migrateLegacyShellHistory(storage: HistoryStorage, write: (entries: LegacyEntry[]) => Promise<{ durable?: boolean }>): Promise<void> {
  // Adding receipt keys can change Storage's enumeration order. Snapshot the
  // original keys before the first network await or receipt write.
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(PREFIX)));
  const encoder = new TextEncoder();
  for (const key of keys) {
    const content = storage.getItem(key);
    if (!content || storage.getItem("piora-shell-migrated:" + key) === content) continue;
    let values: unknown; try { values = JSON.parse(content); } catch { continue; }
    if (!Array.isArray(values)) continue;
    const storedCwd = key.slice(PREFIX.length);
    // The old key normalizer stripped trailing slashes, including root paths.
    const cwd = !storedCwd ? "/" : /^[a-z]:$/i.test(storedCwd) ? storedCwd + "/" : storedCwd;
    let batch: LegacyEntry[] = [], bytes = 14;
    const flush = async () => {
      if (!batch.length) return;
      const result = await write(batch);
      if (result.durable !== true) throw new Error("Legacy history did not receive a durable receipt");
      batch = []; bytes = 14;
    };
    for (const command of values) {
      if (typeof command !== "string" || !command.trim() || command.length > 65536 || command.includes("\0")) continue;
      const entry = { cwd, command }, size = encoder.encode(JSON.stringify(entry)).byteLength;
      if (batch.length && (batch.length === 100 || bytes + size + 1 > 480 * 1024)) await flush();
      batch.push(entry); bytes += size + 1;
    }
    await flush();
    // Preserve the source. A concurrent legacy write differs from this exact
    // receipt and will be picked up on the next pass.
    storage.setItem("piora-shell-migrated:" + key, content);
  }
}
