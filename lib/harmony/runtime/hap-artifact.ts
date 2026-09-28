import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { readBoundedRegularFile, enforceArtifactQuota } from "./bounded-file";
import { HarmonyError } from "../errors";

/** Freeze the selected build before dispatch, without a second authorization flow. */
export async function importHapArtifact(path: string, directory: string): Promise<string> {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== ".hap") {
    throw new HarmonyError("INVALID_ARGUMENT", "An absolute HAP artifact path is required");
  }
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 256 * 1024 * 1024) {
    throw new HarmonyError("INVALID_ARGUMENT", "HAP must be a regular file between 1 byte and 256 MiB");
  }
  const data = await readBoundedRegularFile(path, 256 * 1024 * 1024);
  if (data.length !== info.size) throw new HarmonyError("INVALID_ARGUMENT", "HAP changed while being imported; retry with a stable artifact");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const artifactHash = hash(data);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceArtifactQuota(directory, "hap", data.length);
  const artifactPath = join(directory, `${artifactHash}.hap`);
  try { await writeFile(artifactPath, data, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stored = await lstat(artifactPath);
  if (!stored.isFile() || stored.isSymbolicLink() || hash(await readBoundedRegularFile(artifactPath, 256 * 1024 * 1024)) !== artifactHash) {
    throw new HarmonyError("INVALID_ARGUMENT", "The imported HAP artifact failed integrity verification");
  }
  return artifactPath;
}
