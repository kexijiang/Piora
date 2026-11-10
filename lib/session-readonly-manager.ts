import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";

/** The SDK defines this shape internally but does not export it at its root. */
export type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "buildContextEntries" | "buildSessionProjection" | "getHeader" | "getEntries" | "getTree" | "getSessionName">;

/** Read bytes once, then let the SDK migrate only an isolated in-memory snapshot. */
export function readOnlySessionManager(path: string, options: { expectedSessionId?: string; leafId?: string | null } = {}): ReadonlySessionManager {
  const absolute = resolve(path);
  if (statSync(absolute).size > 64 * 1024 * 1024) throw new Error("Session exceeds the read snapshot size limit");
  const text = readFileSync(absolute, "utf8");
  let entries: FileEntry[];
  try { entries = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error("Session snapshot contains an incomplete or invalid JSON record"); }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string" || (options.expectedSessionId && header.id !== options.expectedSessionId)) throw new Error("Session snapshot identity is invalid");
  if (![1, 2, 3].includes(header.version ?? 1)) throw new Error("Unsupported session snapshot version");
  const manager = SessionManager.inMemory(header.cwd, undefined, entries);
  if (options.leafId !== undefined) {
    if (options.leafId === null) manager.resetLeaf();
    else {
      if (!manager.getEntry(options.leafId)) throw new Error("Selected session branch is missing from disk");
      manager.branch(options.leafId);
    }
  }
  // Expose only SDK read methods; neither a caller nor an SDK helper can open a
  // writable file by calling setSessionFile/appendMessage on this wrapper.
  return Object.freeze({
    getCwd: () => manager.getCwd(), getSessionDir: () => dirname(absolute),
    getSessionId: () => manager.getSessionId(), getSessionFile: () => absolute,
    getLeafId: () => manager.getLeafId(), getLeafEntry: () => manager.getLeafEntry(),
    getEntry: (id: string) => manager.getEntry(id), getLabel: (id: string) => manager.getLabel(id),
    getBranch: (id?: string) => manager.getBranch(id), buildContextEntries: () => manager.buildContextEntries(),
    buildSessionProjection: () => manager.buildSessionProjection(), getHeader: () => manager.getHeader(),
    getEntries: () => manager.getEntries(), getTree: () => manager.getTree(), getSessionName: () => manager.getSessionName(),
  });
}
