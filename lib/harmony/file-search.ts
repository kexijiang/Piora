import { HarmonyError } from "./errors";
import { validateDeviceFilePath, type HarmonyDeviceFile, type HarmonyFileScope } from "./device-files";

export interface HarmonyFileSearchResult { files: HarmonyDeviceFile[]; scannedDirectories: number; skippedDirectories: number; truncated: boolean }

/** Bounded BFS uses the same directory parser as normal browsing; symlinks are never traversed. */
export async function searchHarmonyFiles(scope: HarmonyFileScope, root: string, query: string,
  list: (path: string) => Promise<{ files: HarmonyDeviceFile[]; truncated: boolean }>, signal?: AbortSignal): Promise<HarmonyFileSearchResult> {
  const start = validateDeviceFilePath(scope, root);
  const term = query.trim().toLocaleLowerCase();
  if (!term || term.length > 120 || /[\x00-\x1f\x7f]/.test(term)) throw new HarmonyError("INVALID_ARGUMENT", "Search text must be 1–120 printable characters");
  const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }];
  const visited = new Set<string>();
  const matches: HarmonyDeviceFile[] = [];
  let scannedDirectories = 0, skippedDirectories = 0, scannedEntries = 0, truncated = false;
  while (queue.length && scannedDirectories < 80 && scannedEntries < 4_000 && matches.length < 200) {
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device file search was cancelled");
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    let listing: Awaited<ReturnType<typeof list>>;
    try { listing = await list(current.path); }
    catch (error) { if (current.depth === 0 || signal?.aborted) throw error; skippedDirectories++; continue; }
    scannedDirectories++;
    if (listing.truncated) truncated = true;
    for (const file of listing.files) {
      scannedEntries++;
      if (file.name.toLocaleLowerCase().includes(term)) matches.push(file);
      if (file.kind === "directory" && current.depth < 5 && !visited.has(file.path)) queue.push({ path: file.path, depth: current.depth + 1 });
      else if (file.kind === "directory" && current.depth >= 5) truncated = true;
      if (scannedEntries >= 4_000 || matches.length >= 200) { truncated = true; break; }
    }
  }
  if (queue.length) truncated = true;
  return { files: matches, scannedDirectories, skippedDirectories, truncated };
}
