// Only successful reads are retained, in this renderer's memory. Settings
// pages can reopen immediately while checking the current server state.
const snapshots = new Map<string, unknown>();
export function getSettingsSnapshot<T>(url: string): T | null {
  return (snapshots.get(url) as T | undefined) ?? null;
}
export function rememberSettingsSnapshot<T>(url: string, value: T): T {
  snapshots.set(url, value);
  return value;
}
export async function readSettingsJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("设置读取超时，请重试。")), 10_000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (controller.signal.aborted) throw controller.signal.reason;
    return rememberSettingsSnapshot(url, data as T);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
