import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export type BrowserMode = "builtin" | "background";
export interface BrowserConfig { mode: BrowserMode }

export function readBrowserConfig(root = getAgentDir()): BrowserConfig {
  try {
    const config = JSON.parse(readFileSync(join(root, "piora", "browser.json"), "utf8"));
    return { mode: config?.mode === "background" ? "background" : "builtin" };
  } catch { return { mode: "builtin" }; }
}

export function writeBrowserConfig(value: unknown, root = getAgentDir()): BrowserConfig {
  const mode = (value as Partial<BrowserConfig> | null)?.mode;
  if (mode !== "builtin" && mode !== "background") throw new Error("Invalid browser mode");
  const config = { mode };
  const file = join(root, "piora", "browser.json");
  mkdirSync(dirname(file), { recursive: true });
  writePrivateFileAtomicSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
