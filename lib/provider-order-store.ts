import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

const pathFor = (root: string) => join(root, "piora", "provider-order.json");

export function validateProviderOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10000 || value.some(id => typeof id !== "string" || !id.trim() || id.length > 1000)) {
    throw new Error("Invalid provider order");
  }
  return [...new Set<string>(value)];
}

export function readProviderOrder(root = getAgentDir()): string[] {
  try { return validateProviderOrder(JSON.parse(readFileSync(pathFor(root), "utf8")).providers); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("无法读取渠道顺序，请检查 piora/provider-order.json。");
  }
}

export function writeProviderOrder(value: unknown, root = getAgentDir()): string[] {
  const providers = validateProviderOrder(value);
  const file = pathFor(root);
  mkdirSync(dirname(file), { recursive: true });
  writePrivateFileAtomicSync(file, `${JSON.stringify({ providers }, null, 2)}\n`);
  return providers;
}
