import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HarmonyError } from "../errors";
import { enforceArtifactQuota, readBoundedRegularFile } from "./bounded-file";

/** Freeze a selected upload before the device write fence is crossed. */
export async function importDeviceFileArtifact(path: string, directory: string): Promise<string> {
  if (!isAbsolute(path)) throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute local upload path");
  const before = await lstat(path).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > 256 * 1024 * 1024) {
    throw new HarmonyError("INVALID_ARGUMENT", "Upload must be a regular file no larger than 256 MiB");
  }
  const bytes = await readBoundedRegularFile(path, 256 * 1024 * 1024);
  if (bytes.length !== before.size) throw new HarmonyError("INVALID_ARGUMENT", "Upload changed while being read");
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const hash = digest(bytes);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceArtifactQuota(directory, "bin", bytes.length);
  const artifact = join(directory, `${hash}.bin`);
  try { await writeFile(artifact, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stored = await readBoundedRegularFile(artifact, 256 * 1024 * 1024);
  if (digest(stored) !== hash) throw new HarmonyError("INVALID_RESPONSE", "Frozen upload failed integrity verification");
  return artifact;
}
