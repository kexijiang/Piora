import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getRuntimeAgentDataDirectory } from "./runtime-home";
import { parseGitPorcelainV1 } from "./git-status";
import type { PromptRunIdentity } from "./prompt-run-registry";

const execFileAsync = promisify(execFile);
const MAX_FILES = 5000;
const MAX_DEPTH = 8;
const MAX_HASH_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 20 * 1024 * 1024;
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".cache", ".turbo", "vendor", "target", "__pycache__"]);

export interface PromptFileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
}

export interface PromptFileChanges {
  sessionId: string;
  runId: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "complete" | "aborted" | "error" | "unavailable";
  partial: boolean;
  files: PromptFileChange[];
}

interface Snapshot {
  root: string;
  git: boolean;
  versions: Map<string, string>;
  partial: boolean;
}

export interface PromptFileCapture {
  identity: PromptRunIdentity;
  initial: Promise<Snapshot>;
  startedAt: number;
  cwd: string;
}

declare global {
  var __pioraActivePromptFileChanges: Map<string, PromptFileChanges> | undefined;
}

function getActive(): Map<string, PromptFileChanges> {
  return globalThis.__pioraActivePromptFileChanges ??= new Map();
}

function storagePath(sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return path.join(getRuntimeAgentDataDirectory(), "piora", "prompt-file-changes", `${key}.json`);
}

async function persist(record: PromptFileChanges): Promise<void> {
  const target = storagePath(record.sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(record), "utf8");
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function readPromptFileChanges(sessionId: string): Promise<PromptFileChanges | null> {
  const running = getActive().get(sessionId);
  if (running) return running;
  try {
    const parsed = JSON.parse(await fs.readFile(storagePath(sessionId), "utf8")) as PromptFileChanges;
    if (parsed.sessionId !== sessionId) return null;
    // An in-progress record left on disk after a process restart has no live
    // capture to finish it. Make that gap explicit instead of showing a spinner.
    return parsed.status === "running" ? { ...parsed, status: "unavailable", partial: true } : parsed;
  } catch { return null; }
}

function safeAbsolute(root: string, relative: string): string | null {
  const absolute = path.resolve(root, relative);
  const fromRoot = path.relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null;
  return absolute;
}

async function fingerprint(file: string, budget: { remaining: number; partial: boolean }, gitHash?: "sha1" | "sha256"): Promise<string> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) { budget.partial = true; return "missing"; }
    if (stat.size > MAX_SINGLE_FILE_BYTES || stat.size > budget.remaining) {
      budget.partial = true;
      return `metadata:${stat.size}:${stat.mtimeMs}`;
    }
    budget.remaining -= stat.size;
    const data = await fs.readFile(file);
    return gitHash
      ? `git:${createHash(gitHash).update(`blob ${data.length}\0`).update(data).digest("hex")}`
      : createHash("sha256").update(data).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") budget.partial = true;
    return "missing";
  }
}

async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 8000 });
    return path.resolve(stdout.trim());
  } catch { return null; }
}

async function gitPaths(root: string): Promise<{ paths: string[]; partial: boolean }> {
  const { stdout } = await execFileAsync("git", ["-C", root, "-c", "status.relativePaths=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeout: 15000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" });
  const entries = parseGitPorcelainV1(stdout);
  const paths = [...new Set(entries.flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]))];
  return { paths: paths.slice(0, MAX_FILES), partial: paths.length > MAX_FILES };
}

async function gitTrackedVersions(root: string): Promise<{ versions: Map<string, string>; partial: boolean }> {
  const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--cached", "--stage", "-z"], { timeout: 15000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" });
  const versions = new Map<string, string>();
  let partial = false;
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    const header = separator >= 0 ? entry.slice(0, separator) : "";
    const match = /^\d+ ([0-9a-f]{40,64}) ([0-3])$/.exec(header);
    if (!match || separator < 0) { partial = true; continue; }
    const absolute = safeAbsolute(root, entry.slice(separator + 1));
    if (!absolute) continue;
    if (versions.size >= MAX_FILES && !versions.has(absolute)) { partial = true; break; }
    // A clean tracked file has the index blob as its content baseline. Dirty
    // paths below are replaced with a hash of the actual working file.
    versions.set(absolute, `git:${match[1]}`);
    if (match[2] !== "0") partial = true;
  }
  return { versions, partial };
}

async function gitSnapshot(root: string, extraPaths: Iterable<string> = []): Promise<Snapshot> {
  const [listing, tracked] = await Promise.all([gitPaths(root), gitTrackedVersions(root)]);
  const paths = [...new Set([...listing.paths, ...extraPaths])];
  const budget = { remaining: MAX_HASH_BYTES, partial: listing.partial || tracked.partial || paths.length > MAX_FILES };
  const versions = tracked.versions;
  const gitHash = [...versions.values()].some((version) => version.length === 68) ? "sha256" : "sha1";
  const dirtyPaths = new Set(listing.paths);
  for (const relative of paths) {
    const absolute = safeAbsolute(root, relative);
    if (!absolute) continue;
    if (versions.size >= MAX_FILES && !versions.has(absolute)) { budget.partial = true; continue; }
    if (dirtyPaths.has(relative) || !versions.has(absolute)) versions.set(absolute, await fingerprint(absolute, budget, gitHash));
  }
  return { root, git: true, versions, partial: budget.partial };
}

async function plainSnapshot(root: string): Promise<Snapshot> {
  const versions = new Map<string, string>();
  const budget = { remaining: MAX_HASH_BYTES, partial: false };
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const { directory, depth } = queue[index];
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { budget.partial = true; continue; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) queue.push({ directory: absolute, depth: depth + 1 });
        else budget.partial = true;
      } else if (entry.isFile()) {
        if (versions.size >= MAX_FILES) { budget.partial = true; break; }
        versions.set(absolute, await fingerprint(absolute, budget));
      }
    }
    if (versions.size >= MAX_FILES) break;
  }
  return { root, git: false, versions, partial: budget.partial };
}

async function snapshot(cwd: string, initial?: Snapshot): Promise<Snapshot> {
  const discoveredGitRoot = initial ? null : await gitRoot(cwd);
  const root = initial?.root ?? discoveredGitRoot ?? path.resolve(cwd);
  const git = initial?.git ?? discoveredGitRoot !== null;
  return git ? gitSnapshot(root, initial?.versions.keys()) : plainSnapshot(root);
}

export function beginPromptFileChanges(identity: PromptRunIdentity, cwd: string): PromptFileCapture {
  const startedAt = Date.now();
  const record: PromptFileChanges = { sessionId: identity.sessionId, runId: identity.runId, cwd, startedAt, status: "running", partial: false, files: [] };
  getActive().set(identity.sessionId, record);
  const initial = Promise.all([snapshot(cwd), persist(record).catch(() => {})]).then(([value]) => value);
  return { identity, cwd, startedAt, initial };
}

export async function finishPromptFileChanges(capture: PromptFileCapture, status: "complete" | "aborted" | "error"): Promise<PromptFileChanges> {
  const { identity, cwd, startedAt } = capture;
  let result: PromptFileChanges;
  try {
    const before = await capture.initial;
    const after = await snapshot(cwd, before);
    const files: PromptFileChange[] = [];
    for (const file of new Set([...before.versions.keys(), ...after.versions.keys()])) {
      const oldVersion = before.versions.get(file);
      const newVersion = after.versions.get(file);
      if (oldVersion === newVersion) continue;
      if (oldVersion === undefined && newVersion === "missing") continue;
      files.push({ path: file, kind: newVersion === "missing" ? "deleted" : oldVersion === undefined || oldVersion === "missing" ? "added" : "modified" });
    }
    result = { sessionId: identity.sessionId, runId: identity.runId, cwd, startedAt, finishedAt: Date.now(), status, partial: before.partial || after.partial, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  } catch {
    result = { sessionId: identity.sessionId, runId: identity.runId, cwd, startedAt, finishedAt: Date.now(), status: "unavailable", partial: true, files: [] };
  }
  if (getActive().get(identity.sessionId)?.runId === identity.runId) {
    getActive().set(identity.sessionId, result);
    try { await persist(result); getActive().delete(identity.sessionId); }
    catch { /* Keep the result available in memory. */ }
  }
  return result;
}
