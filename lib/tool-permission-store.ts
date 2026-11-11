import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { isPermissionMode, type PermissionMode, type ToolPermissionState } from "./tool-permission-policy.ts";

function directory(root?: string) {
  return join(root ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "piora", "tool-permissions");
}
function pathFor(id: string, root?: string) {
  if (id === "default" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid session id");
  return join(directory(root), `${id}.json`);
}
export function readToolPermission(id: string, root?: string): ToolPermissionState {
  try {
    const value = JSON.parse(readFileSync(pathFor(id, root), "utf8"));
    if (value.schemaVersion !== undefined && value.schemaVersion !== 2) throw new Error("Unsupported permission record version");
    if (value.mode === "review" && value.schemaVersion !== 2) throw new Error("AI review requires an explicit versioned selection");
    if (!isPermissionMode(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid permission record");
    return { mode: value.mode, revision: value.revision };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "full", revision: 0, legacy: true };
    // Corrupt authorization must never silently grant full access.
    throw error;
  }
}
export function writeToolPermission(id: string, mode: PermissionMode, root?: string): ToolPermissionState {
  if (!isPermissionMode(mode)) throw new Error("Invalid permission mode");
  const path = pathFor(id, root);
  mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  const release = lockfile.lockSync(directory(root), { lockfilePath: `${path}.lock`, realpath: false });
  try {
    const previous = readToolPermission(id, root);
    const state = { mode, revision: previous.revision + 1 };
    writePrivateFileAtomicSync(path, JSON.stringify({ schemaVersion: 2, ...state }));
    return state;
  } finally { release(); }
}
export function readDefaultToolPermission(root?: string): PermissionMode {
  try {
    const value = JSON.parse(readFileSync(join(directory(root), "default.json"), "utf8"));
    if (value.schemaVersion !== undefined && value.schemaVersion !== 2) throw new Error("Unsupported default permission version");
    if (value.mode === "review" && value.schemaVersion !== 2) throw new Error("AI review requires an explicit versioned selection");
    if (!isPermissionMode(value.mode)) throw new Error("Invalid default permission mode");
    return value.mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "full";
    throw error;
  }
}
export function writeDefaultToolPermission(mode: PermissionMode, root?: string) {
  if (!isPermissionMode(mode)) throw new Error("Invalid permission mode");
  mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  const release = lockDefault(root);
  try { persistDefault(mode, root); } finally { release(); }
}

function lockDefault(root?: string) {
  return lockfile.lockSync(join(directory(root), "default.json"), { realpath: false });
}

function persistDefault(mode: PermissionMode, root?: string) {
  writePrivateFileAtomicSync(join(directory(root), "default.json"), JSON.stringify({ schemaVersion: 2, mode }));
}

/** Explicit user choices only. Session creation/restoration uses writeToolPermission. */
export function selectToolPermission(id: string, mode: PermissionMode, root?: string): ToolPermissionState {
  if (!isPermissionMode(mode)) throw new Error("Invalid permission mode");
  pathFor(id, root);
  mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  const release = lockDefault(root);
  try {
    const previous = readDefaultToolPermission(root);
    // Do not grant session access if saving the preference fails.
    persistDefault(mode, root);
    try { return writeToolPermission(id, mode, root); }
    catch (error) {
      persistDefault(previous, root);
      throw error;
    }
  } finally { release(); }
}
