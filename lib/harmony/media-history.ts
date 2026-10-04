import { lstat, opendir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveHarmonyStorage, safeHarmonyDeviceName } from "./artifacts";
import { HarmonyError } from "./errors";
import type { HarmonyConfig, HarmonyMediaArtifact } from "./types";

const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_HISTORY = 40;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Candidate = { kind: "screenshot" | "recording"; directory: string; filename: string; createdAt: string };

function generatedTime(filename: string, prefix: string, extension: "png" | "mp4"): string | undefined {
  if (!filename.startsWith(`${prefix}-`)) return;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}\.(png|mp4)$/.exec(filename.slice(prefix.length + 1));
  if (!match || match[6] !== extension) return;
  const timestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

async function screenshotSize(path: string): Promise<{ width: number; height: number } | undefined> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(24);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || !header.subarray(0, 8).equals(PNG_HEADER)
      || header.toString("ascii", 12, 16) !== "IHDR") return;
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (!width || !height || width > 16_384 || height > 16_384) return;
    return { width, height };
  } finally { await file.close(); }
}

/** Rediscover saved results from the configured private media folders after a desktop restart. */
export async function listHarmonyMediaHistory(config: HarmonyConfig, serial: string): Promise<{ artifacts: HarmonyMediaArtifact[]; truncated: boolean }> {
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid device");
  const prefix = safeHarmonyDeviceName(serial);
  const storage = resolveHarmonyStorage(config);
  const folders = [{ kind: "screenshot" as const, directory: storage.screenshotDirectory, extension: "png" as const },
    { kind: "recording" as const, directory: storage.recordingDirectory, extension: "mp4" as const }];
  const candidates: Candidate[] = [];
  let truncated = false;
  for (const folder of folders) {
    if (!isAbsolute(folder.directory)) throw new HarmonyError("INVALID_ARGUMENT", "Harmony media storage paths must be absolute");
    const info = await lstat(folder.directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Media history directory is not a regular directory");
    const directory = await opendir(folder.directory);
    let scanned = 0;
    try {
      for await (const entry of directory) {
        if (++scanned > MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
        if (!entry.isFile()) continue;
        const createdAt = generatedTime(entry.name, prefix, folder.extension);
        if (createdAt) candidates.push({ kind: folder.kind, directory: folder.directory, filename: entry.name, createdAt });
      }
    } finally { await directory.close().catch(() => undefined); }
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (candidates.length > MAX_HISTORY) truncated = true;
  const artifacts: HarmonyMediaArtifact[] = [];
  for (const candidate of candidates.slice(0, MAX_HISTORY * 2)) {
    const path = join(candidate.directory, candidate.filename);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1) continue;
    const dimensions = candidate.kind === "screenshot" ? await screenshotSize(path).catch(() => undefined) : undefined;
    if (candidate.kind === "screenshot" && (!dimensions || info.size > 20 * 1024 * 1024)) continue;
    artifacts.push({ kind: candidate.kind, serial, path, filename: candidate.filename,
      createdAt: candidate.createdAt, size: info.size, ...(dimensions ?? {}), mimeType: candidate.kind === "screenshot" ? "image/png" : "video/mp4" });
    if (artifacts.length >= MAX_HISTORY) break;
  }
  return { artifacts, truncated };
}
