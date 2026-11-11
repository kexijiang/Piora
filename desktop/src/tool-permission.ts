import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read the same app-owned session policy as the server; never trust a model-supplied mode. */
export function hasFullToolAccess(root: string | undefined, sessionId: string): boolean {
  if (!root || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return false;
  try {
    const value = JSON.parse(readFileSync(join(root, "piora", "tool-permissions", `${sessionId}.json`), "utf8"));
    return (value.schemaVersion === undefined || value.schemaVersion === 2) && value.mode === "full" && Number.isSafeInteger(value.revision) && value.revision > 0;
  } catch { return false; }
}
