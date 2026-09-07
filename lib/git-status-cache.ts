import { createAsyncSnapshotCache } from "./async-snapshot-cache";
import { getGitStatus } from "./git-changes";
import type { GitStatusResponse } from "./git-types";
import { resolve } from "node:path";

declare global {
  var __pioraGitStatusCache: ReturnType<typeof createAsyncSnapshotCache<GitStatusResponse>> | undefined;
}
function cache() { return globalThis.__pioraGitStatusCache ??= createAsyncSnapshotCache<GitStatusResponse>(1_000); }
export function invalidateGitStatusCache() { cache().invalidate(); }
export function getCachedGitStatus(cwd: string) {
  const key = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
  return cache().get(key, () => getGitStatus(cwd));
}
