import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

const pathFor = (root: string) => join(root, "piora", "removed-providers.json");

/** A provider-level exclusion survives external credentials and catalog changes. */
export function readRemovedProviders(root = getAgentDir()): string[] {
  try {
    const value = JSON.parse(readFileSync(pathFor(root), "utf8"));
    if (!Array.isArray(value.providers) || value.providers.some((id: unknown) => typeof id !== "string" || !id.trim())) throw new Error("invalid providers");
    return [...new Set<string>(value.providers)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("无法读取已移除渠道设置，请修复 piora/removed-providers.json 后重试。");
  }
}

export function setProviderRemoved(provider: string, removed: boolean, root = getAgentDir()): boolean {
  if (!provider.trim()) throw new Error("provider is required");
  const previous = readRemovedProviders(root);
  if (previous.includes(provider) === removed) return false;
  save(removed ? [...previous, provider] : previous.filter(id => id !== provider), root);
  return true;
}

export function restoreRemovedProviders(root = getAgentDir()): boolean {
  if (!readRemovedProviders(root).length) return false;
  save([], root);
  return true;
}

function save(providers: string[], root: string): void {
  const file = pathFor(root);
  mkdirSync(dirname(file), { recursive: true });
  writePrivateFileAtomicSync(file, `${JSON.stringify({ providers }, null, 2)}\n`);
}
