import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { createHash } from "node:crypto";

/**
 * Reversible session deletion (task T-01).
 *
 * Deleting a session moves its whole subtree (the session plus every
 * descendant that points at it via parentSession) into a trash directory
 * OUTSIDE the sessions tree — `~/.pi/agent/trash/sessions/` — because
 * `SessionManager.listAll` scans every subdirectory under the sessions root,
 * so a `.trash` inside it would resurface the deleted files. A small
 * per-session manifest records original → trashed paths so restore is an
 * exact move-back and cascade re-parenting (which mutates children) never
 * has to be reversed.
 *
 * The move is atomic per file (rename on the same volume), and the manifest
 * is written before any file moves, so an interrupted delete can still be
 * restored or purged on the next run.
 */

export interface TrashEntry {
  /** Absolute path the file had while it was a live session. */
  original: string;
  /** Absolute path it currently sits at inside the trash root. */
  trashed: string;
}

export interface TrashManifest {
  /** Session id of the deleted root session. */
  id: string;
  /** Epoch ms of the move — purge uses this. */
  trashedAt: number;
  entries: TrashEntry[];
  title?: string;
  cwd?: string;
}

export const TRASH_UNDO_WINDOW_MS = 5_000;
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** `~/.pi/agent/trash/sessions` — deliberately outside the sessions root. */
export function getTrashRoot(): string {
  return join(getAgentDir(), "trash", "sessions");
}

function manifestPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid recycle bin id");
  return join(getTrashRoot(), `${id}.manifest.json`);
}

export function readTrashManifest(id: string): TrashManifest | null {
  try {
    const raw = readFileSync(manifestPath(id), "utf8");
    const parsed = JSON.parse(raw) as TrashManifest;
    if (parsed.id !== id || !Number.isFinite(parsed.trashedAt) || !Array.isArray(parsed.entries)) return null;
    const root = resolve(getTrashRoot(), id);
    return parsed.entries.every((entry) => {
      if (typeof entry.original !== "string" || !isAbsolute(entry.original) || typeof entry.trashed !== "string") return false;
      const child = relative(root, resolve(entry.trashed));
      return child !== "" && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child);
    }) ? parsed : null;
  } catch {
    return null;
  }
}

function writeManifest(manifest: TrashManifest): void {
  mkdirSync(getTrashRoot(), { recursive: true });
  writeFileSync(manifestPath(manifest.id), JSON.stringify(manifest, null, 2), "utf8");
}

function removeManifest(id: string): void {
  try {
    unlinkSync(manifestPath(id));
  } catch {
    // already gone
  }
}

/**
 * Move the given files into the trash. The manifest is written first so a
 * crash between writes leaves a restorable (or purgable) record.
 */
export function trashSession(id: string, files: string[], metadata: { title?: string; cwd?: string } = {}): TrashManifest {
  if (readTrashManifest(id)) throw new Error("This conversation is already in the recycle bin");
  const entries: TrashEntry[] = files.map((original) => ({
    original,
    trashed: join(getTrashRoot(), `${id}`, sanitizeSegment(original)),
  }));
  const manifest: TrashManifest = { id, trashedAt: Date.now(), entries, ...metadata };
  writeManifest(manifest);
  const moved: TrashEntry[] = [];
  try {
    for (const entry of entries) {
      if (!existsSync(entry.original)) throw new Error("A conversation file changed during deletion. Refresh and try again.");
      mkdirSync(dirname(entry.trashed), { recursive: true });
      renameSync(entry.original, entry.trashed);
      moved.push(entry);
    }
  } catch (error) {
    // Restore the original tree on partial failure; retain the manifest if rollback fails.
    for (const entry of moved.reverse()) renameSync(entry.trashed, entry.original);
    removeManifest(id);
    throw error;
  }
  return manifest;
}

/** Move every trashed file back to its original path. Returns false if the
 *  undo window has already been purged. */
export function restoreSession(id: string): boolean {
  const manifest = readTrashManifest(id);
  if (!manifest) return false;
  if (manifest.entries.some((entry) => !existsSync(entry.trashed) && !existsSync(entry.original))) {
    throw new Error("A conversation file is missing from the recycle bin. Recovery was not completed.");
  }
  const available = manifest.entries.filter((entry) => existsSync(entry.trashed));
  if (available.some((entry) => existsSync(entry.original))) {
    throw new Error("A conversation already exists at the original location. Nothing was overwritten.");
  }
  const moved: TrashEntry[] = [];
  try {
    for (const entry of available) {
      mkdirSync(dirname(entry.original), { recursive: true });
      renameSync(entry.trashed, entry.original);
      moved.push(entry);
    }
  } catch (error) {
    for (const entry of moved.reverse()) renameSync(entry.original, entry.trashed);
    throw error;
  }
  removeManifest(id);
  return true;
}

/** Permanently delete every trashed file older than `olderThanMs`. Safe to
 *  call on startup and after each new delete to sweep stale manifests. */
export function purgeExpiredTrash(olderThanMs = TRASH_RETENTION_MS): void {
  const root = getTrashRoot();
  if (!existsSync(root)) return;
  const now = Date.now();
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".manifest.json")) continue;
    const manifest = readTrashManifest(name.slice(0, -".manifest.json".length));
    if (!manifest || now - manifest.trashedAt < olderThanMs) continue;
    let removed = true;
    for (const entry of manifest.entries) {
      try {
        rmSync(entry.trashed, { recursive: true, force: true });
      } catch {
        removed = false;
      }
    }
    if (removed) removeManifest(manifest.id);
  }
}

export function listTrashSessions(): Array<{ id: string; title: string; cwd: string; trashedAt: number; expiresAt: number; count: number }> {
  const root = getTrashRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    if (!name.endsWith(".manifest.json")) return [];
    const manifest = readTrashManifest(name.slice(0, -".manifest.json".length));
    if (!manifest) return [];
    return [{ id: manifest.id, title: manifest.title || manifest.id, cwd: manifest.cwd || "", trashedAt: manifest.trashedAt,
      expiresAt: manifest.trashedAt + TRASH_RETENTION_MS, count: manifest.entries.length }];
  }).sort((a, b) => b.trashedAt - a.trashedAt);
}

/** Trash files live under `trash/sessions/<id>/` with a short deterministic
 *  segment derived from the original path — sanitizing the raw path could
 *  exceed the Windows 260-char path limit for deeply nested sessions. */
function sanitizeSegment(filePath: string): string {
  const key = filePath.replace(/\\/g, "/");
  return `${createHash("sha256").update(key).digest("hex")}.jsonl`;
}
