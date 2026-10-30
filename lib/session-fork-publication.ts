import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OwnedSessionManager } from "./session-owned-manager";
import { readOnlySessionManager } from "./session-readonly-manager";

/** Build outside the catalog's sessions/ tree; the rename is publication. */
export function createSessionForkPublication(sourceFile: string, options: { root?: string; sessionDir?: string } = {}) {
  const original = resolve(sourceFile), destination = resolve(options.sessionDir ?? dirname(original));
  const parent = resolve(options.root ?? getAgentDir(), "piora", "session-forks");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stagingDir = mkdtempSync(join(parent, "fork-")), canonical = realpathSync(stagingDir);
  let published: string | undefined, disposed = false;
  const assertDirectory = () => {
    if (disposed || dirname(resolve(stagingDir)) !== parent || !resolve(stagingDir).startsWith(`${parent}${sep}`)
      || realpathSync(stagingDir) !== canonical) throw new Error("Fork staging directory identity changed");
  };
  return {
    stagingDir,
    /** Call only after metadata, profile binding and both parameter stores finish.
     * The owned manager must be released, without further writes, after publish. */
    publish(owned: OwnedSessionManager): string {
      owned.assertOwned(); assertDirectory();
      if (published) return published;
      const staged = owned.manager.getSessionFile();
      if (!staged || dirname(resolve(staged)) !== resolve(stagingDir) || !staged.endsWith(".jsonl")) throw new Error("Fork is not in its private staging directory");
      const snapshot = readOnlySessionManager(staged, { expectedSessionId: owned.manager.getSessionId() });
      if (resolve(snapshot.getHeader()?.parentSession ?? "") !== original) throw new Error("Fork parent session changed before publication");
      const finalFile = join(destination, basename(staged));
      if (existsSync(finalFile)) throw new Error("Fork destination already exists");
      const fd = openSync(staged, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
      owned.assertOwned(); assertDirectory();
      if (existsSync(finalFile)) throw new Error("Fork destination already exists");
      renameSync(staged, finalFile);
      published = finalFile;
      return finalFile;
    },
    /** Lost ownership keeps hidden staging data for recovery instead of writing. */
    dispose(owned?: OwnedSessionManager): boolean {
      if (disposed) return true;
      if (owned) { try { owned.assertOwned(); } catch { return false; } }
      try {
        assertDirectory();
        if (owned) rmSync(stagingDir, { recursive: true, force: false });
        else {
          // A failed manager constructor may already have released its lease.
          // Only remove an empty directory when no ownership guard is available.
          rmdirSync(stagingDir);
        }
      } catch { return false; }
      disposed = true;
      return true;
    },
  };
}
