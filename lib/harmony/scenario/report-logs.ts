import { asHarmonyError, HarmonyError } from "../errors";
import type { HarmonyAutomationBackend, HarmonyLogEntry, HarmonyScenarioResult } from "../types";

const LIMIT = 200;
const MAX_BYTES = 128 * 1024;

/** A user-selected bounded device tail, never a claim of complete run-scoped logs. */
export async function collectScenarioLogs(backend: HarmonyAutomationBackend, serial: string, signal: AbortSignal): Promise<NonNullable<HarmonyScenarioResult["logs"]>> {
  const base = { capturedAt: new Date().toISOString(), source: "device-tail" as const, limit: LIMIT };
  try {
    signal.throwIfAborted();
    if (!backend.readLogs) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device cannot provide report logs");
    const source = await backend.readLogs(serial, { limit: LIMIT, signal });
    signal.throwIfAborted();
    const entries: HarmonyLogEntry[] = [];
    let truncated = source.length > LIMIT, bytes = 0;
    const clip = (value: string, length: number) => { if (value.length > length) truncated = true; return value.slice(0, length); };
    // Retain the most recent rows when the byte limit is reached.
    for (const row of source.slice(-LIMIT).reverse()) {
      const entry: HarmonyLogEntry = {
        level: row.level, ...(row.timestamp ? { timestamp: clip(row.timestamp, 64) } : {}),
        ...(row.pid !== undefined ? { pid: row.pid } : {}), ...(row.tid !== undefined ? { tid: row.tid } : {}),
        ...(row.domain ? { domain: clip(row.domain, 128) } : {}), ...(row.tag ? { tag: clip(row.tag, 128) } : {}),
        message: clip(row.message, 2048), raw: clip(row.raw, 2048),
      };
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
      if (bytes + size > MAX_BYTES) { truncated = true; break; }
      entries.unshift(entry); bytes += size;
    }
    return { ...base, capturedAt: new Date().toISOString(), status: "collected", entries, truncated };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ...base, status: "failed", entries: [], truncated: false, error: asHarmonyError(error).toJSON() };
  }
}
