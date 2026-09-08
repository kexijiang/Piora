import { existsSync, writeFileSync } from "node:fs";

type LazySessionManager = {
  getSessionFile(): string | undefined;
  getHeader(): unknown;
  getEntries(): unknown[];
};

/**
 * Persist a newly-created SDK session before its first assistant message.
 *
 * Pi intentionally delays that first write. Managed Team Agents need a durable
 * session immediately, though, because the server may restart while an Agent is
 * idle and only its binding id remains in the room store.
 */
export function persistLazySessionManager(manager: LazySessionManager): string | undefined {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return sessionFile;

  const header = manager.getHeader();
  if (!header) return undefined;

  const content = [header, ...manager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });

  // SessionManager.flushed is private in the SDK type but remains runtime
  // state. Marking it prevents the next assistant message from trying to
  // recreate the file with the exclusive `wx` flag.
  (manager as unknown as { flushed: boolean }).flushed = true;
  return sessionFile;
}
