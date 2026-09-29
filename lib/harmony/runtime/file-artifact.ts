import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HarmonyError } from "../errors";
import { MAX_DEVICE_TRANSFER_BYTES } from "../device-transfer-limits";
import { enforceArtifactQuota } from "./bounded-file";
import { assertUnredirectedPath } from "./path-safety";

const CHUNK_BYTES = 1024 * 1024;

async function digestStoredFile(path: string, expectedSize: number): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedSize) throw new HarmonyError("INVALID_RESPONSE", "Frozen upload is not a regular file of the expected size");
  await assertUnredirectedPath(path);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new HarmonyError("INVALID_RESPONSE", "Frozen upload changed before verification");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < expectedSize) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (!bytesRead) throw new HarmonyError("INVALID_RESPONSE", "Frozen upload ended before verification completed");
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== expectedSize || after.mtimeMs !== opened.mtimeMs) throw new HarmonyError("INVALID_RESPONSE", "Frozen upload changed during verification");
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** Freeze a selected upload before the device write fence is crossed, without allocating the whole file. */
export async function importDeviceFileArtifact(path: string, directory: string, signal?: AbortSignal): Promise<string> {
  if (!isAbsolute(path)) throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute local upload path");
  const before = await lstat(path).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_DEVICE_TRANSFER_BYTES) {
    throw new HarmonyError("INVALID_ARGUMENT", "Upload must be a regular file no larger than 1 GiB");
  }
  await assertUnredirectedPath(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceArtifactQuota(directory, "bin", before.size);
  const temporary = join(directory, `.piora-upload-${randomUUID()}.tmp`);
  const source = await open(path, "r");
  try {
    const opened = await source.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new HarmonyError("INVALID_ARGUMENT", "Upload changed before it could be frozen");
    }
    const target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let hash: string;
    try {
      const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = 0;
      while (position < before.size) {
        if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Upload preparation was cancelled");
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw new HarmonyError("INVALID_ARGUMENT", "Upload changed while being frozen");
        digest.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(buffer, written, bytesRead - written, position + written);
          if (!result.bytesWritten) throw new HarmonyError("INVALID_RESPONSE", "Frozen upload write was incomplete");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      const after = await source.stat();
      const named = await lstat(path);
      if (after.size !== before.size || after.mtimeMs !== opened.mtimeMs || named.dev !== opened.dev || named.ino !== opened.ino) {
        throw new HarmonyError("INVALID_ARGUMENT", "Upload changed while being frozen");
      }
      await target.sync();
      hash = digest.digest("hex");
    } finally { await target.close(); }
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Upload preparation was cancelled");
    const artifact = join(directory, `${hash}.bin`);
    let linked = false;
    try { await link(temporary, artifact); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try {
      if (await digestStoredFile(artifact, before.size) !== hash) throw new HarmonyError("INVALID_RESPONSE", "Frozen upload failed integrity verification");
      if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Upload preparation was cancelled");
      return artifact;
    } catch (error) {
      if (linked) await rm(artifact, { force: true });
      throw error;
    }
  } finally {
    await source.close();
    await rm(temporary, { force: true });
  }
}
