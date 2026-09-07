import { createAsyncSnapshotCache } from "./async-snapshot-cache";
import type { GitStatusResponse } from "./git-types";

const cache = createAsyncSnapshotCache<GitStatusResponse>(1_000);
if (typeof window !== "undefined") window.addEventListener("piora:git-status-changed", () => cache.invalidate());

export async function requestGitStatus(cwd: string, options: { signal?: AbortSignal; summary?: boolean } = {}): Promise<GitStatusResponse> {
  options.signal?.throwIfAborted();
  const projection = options.summary ? "summary" : "files";
  const pending = cache.get(`${cwd}:${projection}`, async () => {
    const params = new URLSearchParams({ cwd, projection });
    const response = await fetch(`/api/git/status?${params}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body as GitStatusResponse;
  });
  // One subscriber cancelling must not abort the shared request for other panels.
  const signal = options.signal;
  if (!signal) return pending;
  return new Promise<GitStatusResponse>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then((result) => { if (!signal.aborted) resolve(result); }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
