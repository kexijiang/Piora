import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { HarmonyError } from "./errors";
import type { HarmonyConfig, HarmonyMediaArtifact, HarmonyScreenshot } from "./types";

function defaultMediaRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const desktopData = environment.PIORA_DESKTOP_DATA_DIR?.trim();
  return desktopData
    ? join(resolve(desktopData), "harmony-media")
    : join(homedir(), ".piora", "harmony-media");
}

export function resolveHarmonyStorage(config: HarmonyConfig, environment: NodeJS.ProcessEnv = process.env): {
  screenshotDirectory: string;
  recordingDirectory: string;
} {
  const root = defaultMediaRoot(environment);
  return {
    screenshotDirectory: config.storage?.screenshotDirectory || join(root, "screenshots"),
    recordingDirectory: config.storage?.recordingDirectory || join(root, "recordings"),
  };
}

export function safeHarmonyDeviceName(serial: string): string {
  const normalized = serial.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (normalized === serial) return normalized || "device";
  const hash = createHash("sha256").update(serial).digest("hex").slice(0, 16);
  return `${(normalized || "device").slice(0, 47)}-${hash}`;
}

function timestampName(timestamp: Date): string {
  return timestamp.toISOString().replace(/[:.]/g, "-");
}

export function nextHarmonyArtifactPath(
  config: HarmonyConfig,
  kind: "screenshot" | "recording",
  serial: string,
  createdAt = new Date(),
): string {
  const storage = resolveHarmonyStorage(config);
  const directory = kind === "screenshot" ? storage.screenshotDirectory : storage.recordingDirectory;
  if (!isAbsolute(directory)) throw new HarmonyError("INVALID_ARGUMENT", "Harmony media storage paths must be absolute");
  const extension = kind === "screenshot" ? "png" : "mp4";
  return join(directory, `${safeHarmonyDeviceName(serial)}-${timestampName(createdAt)}-${randomUUID().slice(0, 8)}.${extension}`);
}

export async function prepareHarmonyRecordingPath(
  config: HarmonyConfig,
  serial: string,
  createdAt = new Date(),
): Promise<string> {
  const path = nextHarmonyArtifactPath(config, "recording", serial, createdAt);
  await mkdir(dirname(path), { recursive: true });
  return path;
}

export async function saveHarmonyScreenshot(
  config: HarmonyConfig,
  serial: string,
  screenshot: HarmonyScreenshot,
  createdAt = new Date(),
): Promise<HarmonyMediaArtifact> {
  const path = nextHarmonyArtifactPath(config, "screenshot", serial, createdAt);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, screenshot.data, { mode: 0o600 });
  const info = await stat(path);
  return {
    kind: "screenshot",
    serial,
    path,
    filename: basename(path),
    createdAt: createdAt.toISOString(),
    size: info.size,
    width: screenshot.width,
    height: screenshot.height,
    mimeType: "image/png",
  };
}

export async function recordingArtifact(
  serial: string,
  path: string,
  createdAt: Date,
): Promise<HarmonyMediaArtifact> {
  const info = await stat(path);
  return {
    kind: "recording",
    serial,
    path,
    filename: basename(path),
    createdAt: createdAt.toISOString(),
    size: info.size,
    mimeType: "video/mp4",
  };
}
