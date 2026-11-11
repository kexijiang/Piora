import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { readToolPermission } from "./tool-permission-store.ts";
import type { ToolPermissionState } from "./tool-permission-policy";

export function readToolApprovalSettings(root = getAgentDir()): { enabled: boolean; revision: number } {
  try {
    const value = JSON.parse(readFileSync(join(root, "piora", "tool-approval.json"), "utf8"));
    if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Invalid tool approval settings");
    return { enabled: value.enabled, revision: value.revision };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true, revision: 0 };
    throw error;
  }
}
export function writeToolApprovalSettings(value: unknown, root = getAgentDir()) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as { enabled?: unknown }).enabled !== "boolean") throw new TypeError("Expected a boolean enabled field");
  const settings = { enabled: (value as { enabled: boolean }).enabled, revision: readToolApprovalSettings(root).revision + 1 };
  const path = join(root, "piora", "tool-approval.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify(settings));
  return settings;
}
/** The global switch never overwrites a chat's remembered mode. */
export function readEffectiveToolPermission(id: string, root = getAgentDir()): ToolPermissionState {
  const settings = readToolApprovalSettings(root);
  if (!settings.enabled) return { mode: "full", revision: -settings.revision - 1 };
  const permission = readToolPermission(id, root);
  // Pair revisions so toggling off and back on invalidates an in-flight review.
  const sum = settings.revision + permission.revision;
  return { ...permission, revision: sum * (sum + 1) / 2 + permission.revision };
}
