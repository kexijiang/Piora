import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { SessionManager, parseSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";
import {
  retainSessionFileOwnership,
  SessionOwnershipError,
  type SessionFileOwnership,
} from "./session-file-ownership";

export interface OwnedSessionManager {
  manager: SessionManager;
  assertOwned(): void;
  onCompromised(listener: () => void): () => void;
  /** Release only after the runtime and its shutdown hooks have stopped writing. */
  release(): void;
}

// Pi 1.4.0 has no persistence hook. These instance methods cover its append,
// initial flush, migration and branch rewrite paths. Keep the real-SDK tests
// when upgrading Pi; neither its prototype nor its authenticated files change.
interface WritableManagerInternals {
  sessionId: string;
  fileEntries: FileEntry[];
  _persist(entry: FileEntry): void;
  _appendEntry(entry: FileEntry): void;
  _rewriteFile(): void;
  _setSessionFile(path: string, preloaded?: FileEntry[]): void;
}

function readFileEntries(path: string): { entries: FileEntry[]; needsNewline: boolean } {
  if (!existsSync(path)) return { entries: [], needsNewline: false };
  const content = readFileSync(path, "utf8");
  const parsed = parseSessionEntries(content);
  const header = parsed[0];
  // Match Pi's loadEntriesFromFile validation before it repairs a missing LF.
  const valid = header?.type === "session" && typeof header.id === "string";
  return { entries: valid ? parsed : [], needsNewline: valid && !!content && !content.endsWith("\n") };
}

function guardManager(manager: SessionManager, initialOwner: SessionFileOwnership, root?: string): OwnedSessionManager {
  const internals = manager as unknown as WritableManagerInternals;
  for (const name of ["_persist", "_appendEntry", "_rewriteFile", "_setSessionFile"] as const) {
    if (typeof internals[name] !== "function") throw new Error(`Unsupported Pi SessionManager: missing ${name}`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(internals, "sessionId");
  if (!descriptor?.configurable || typeof descriptor.value !== "string") {
    throw new Error("Unsupported Pi SessionManager: sessionId is not an own configurable string");
  }
  const owners = new Map<string, SessionFileOwnership>([[initialOwner.sessionId, initialOwner]]);
  const listeners = new Set<() => void>();
  let currentId = manager.getSessionId();
  let released = false;
  let compromised = false;
  const notifyCompromised = () => {
    if (released || compromised) return;
    compromised = true;
    for (const listener of listeners) {
      try { listener(); } catch { /* Revocation must reach the remaining listeners. */ }
    }
  };
  initialOwner.onCompromised(notifyCompromised);

  const assertOwned = () => {
    if (released || compromised) throw new SessionOwnershipError("Session write ownership is no longer active.");
    for (const owner of owners.values()) owner.assertOwned();
  };
  const ownId = (id: string) => {
    assertOwned();
    let owner = owners.get(id);
    if (!owner) {
      owner = retainSessionFileOwnership(id, root);
      owners.set(id, owner);
      owner.onCompromised(notifyCompromised);
    }
    owner.assertOwned();
    return owner;
  };

  Object.defineProperty(internals, "sessionId", {
    enumerable: true,
    configurable: false,
    get: () => currentId,
    set: (id: string) => {
      // newSession and createBranchedSession assign the new ID before their
      // first write. Acquire it before that assignment, retaining older IDs.
      ownId(id);
      currentId = id;
    },
  });
  const persist = internals._persist.bind(manager);
  const appendEntry = internals._appendEntry.bind(manager);
  const rewrite = internals._rewriteFile.bind(manager);
  const setSessionFile = internals._setSessionFile.bind(manager);
  internals._persist = entry => { assertOwned(); persist(entry); };
  internals._rewriteFile = () => { assertOwned(); rewrite(); };
  // _appendEntry mutates memory before _persist. Reject revoked writes before
  // either changes, so failed writes cannot leave phantom history in memory.
  internals._appendEntry = entry => { assertOwned(); appendEntry(entry); };
  internals._setSessionFile = path => {
    assertOwned();
    const absolutePath = resolve(path);
    const { entries, needsNewline } = readFileEntries(absolutePath);
    const header = entries[0];
    if (header?.type === "session") {
      const owner = ownId(header.id);
      if (needsNewline) {
        owner.assertOwned();
        appendFileSync(absolutePath, "\n");
      }
    }
    // Passing entries bypasses SDK loadEntriesFromFile, whose hidden LF repair
    // precedes _loadEntries and cannot be guarded by _persist/_rewriteFile.
    assertOwned();
    setSessionFile(absolutePath, entries);
  };
  const branch = manager.createBranchedSession.bind(manager);
  manager.createBranchedSession = leafId => {
    assertOwned();
    const previousId = currentId;
    const previousEntries = internals.fileEntries;
    try { return branch(leafId); }
    catch (error) {
      // Pi replaces fileEntries immediately before assigning the new ID. If
      // acquiring that ID failed, leave the original manager coherent.
      if (currentId === previousId) internals.fileEntries = previousEntries;
      throw error;
    }
  };

  return {
    manager,
    assertOwned,
    onCompromised: listener => {
      if (released) throw new SessionOwnershipError("Session write ownership is no longer active.");
      listeners.add(listener);
      if (compromised) listener();
      return () => { listeners.delete(listener); };
    },
    release: () => {
      if (released) return;
      released = true;
      listeners.clear();
      let failure: unknown;
      for (const owner of owners.values()) {
        try { owner.release(); } catch (error) { failure ??= error; }
      }
      owners.clear();
      if (failure) throw failure;
    },
  };
}

function createWithId(cwd: string, sessionDir: string | undefined, id: string, root?: string): OwnedSessionManager {
  const owner = retainSessionFileOwnership(id, root);
  try {
    owner.assertOwned();
    // Pi.create only creates the directory and an in-memory header. Unlike
    // Pi.open it cannot migrate or repair an existing transcript in construction.
    const manager = SessionManager.create(cwd, sessionDir, { id });
    return guardManager(manager, owner, root);
  } catch (error) {
    owner.release();
    throw error;
  }
}

export function createOwnedSessionManager(cwd: string, sessionDir?: string, root?: string): OwnedSessionManager {
  return createWithId(cwd, sessionDir, uuidv7(), root);
}

export function openOwnedSessionManager(path: string, sessionDir?: string, root?: string): OwnedSessionManager {
  const absolutePath = resolve(path);
  const { entries } = readFileEntries(absolutePath);
  const header = entries[0];
  const id = header?.type === "session" ? header.id : uuidv7();
  const cwd = header?.type === "session" && typeof header.cwd === "string" ? header.cwd : process.cwd();
  const owned = createWithId(cwd, sessionDir ?? dirname(absolutePath), id, root);
  try {
    owned.manager.setSessionFile(absolutePath);
    return owned;
  } catch (error) {
    owned.release();
    throw error;
  }
}
