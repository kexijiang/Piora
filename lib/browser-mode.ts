import { readFileSync } from "node:fs";
import { join } from "node:path";

export type AgentBrowserMode = "builtin" | "background";

/** Missing or unreadable config means the desktop embedded browser. */
export function readAgentBrowserMode(agentDir?: string): AgentBrowserMode {
  const root = agentDir ?? process.env.PI_CODING_AGENT_DIR;
  if (!root) return "builtin";
  try {
    const parsed = JSON.parse(readFileSync(join(root, "piora", "browser.json"), "utf8")) as { mode?: unknown };
    return parsed.mode === "background" ? "background" : "builtin";
  } catch {
    return "builtin";
  }
}
