import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

const configPath = (root: string) => join(root, "piora", "model-fallback.json");

export function readModelFallbackConfig(root = getAgentDir()): { enabled: boolean } {
  try {
    const value = JSON.parse(readFileSync(configPath(root), "utf8"));
    return { enabled: value?.enabled === true };
  } catch { return { enabled: false }; }
}

export function writeModelFallbackConfig(value: unknown, root = getAgentDir()): { enabled: boolean } {
  if (!value || typeof value !== "object" || typeof (value as { enabled?: unknown }).enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const config = { enabled: (value as { enabled: boolean }).enabled };
  const path = configPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
