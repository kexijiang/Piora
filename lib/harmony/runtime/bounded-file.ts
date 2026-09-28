import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HarmonyError } from "../errors";
import { assertUnredirectedPath } from "./path-safety";

/** Cap allocation and bytes read even when a file grows after admission. */
export async function readBoundedRegularFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new HarmonyError("INVALID_ARGUMENT", "Artifact must be a bounded regular file without redirected parents");
  await assertUnredirectedPath(path);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new HarmonyError("INVALID_ARGUMENT", "Artifact changed before it could be read");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs) throw new HarmonyError("INVALID_ARGUMENT", "Artifact changed while reading; use an immutable copy");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Only generated hash filenames in a private store are eligible for expiry. */
export async function enforceArtifactQuota(directory: string, extension: "wav" | "hap" | "bin", incomingBytes: number, now = Date.now()) {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new HarmonyError("INVALID_ARGUMENT", "Private artifact storage cannot contain redirected paths");
  await assertUnredirectedPath(directory);
  const names = await readdir(directory);
  const pattern = new RegExp(`^[a-f0-9]{64}\\.${extension}$`);
  let bytes = 0, count = 0;
  for (const name of names.filter(name => pattern.test(name))) {
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new HarmonyError("INVALID_ARGUMENT", "Invalid private artifact store entry");
    if (now - info.mtimeMs > 30 * 24 * 60 * 60_000) await unlink(path);
    else { count++; bytes += info.size; }
  }
  if (count >= 500 || bytes + incomingBytes > 1024 * 1024 * 1024) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Private artifact store reached 500 files or 1 GiB; remove unused imported copies before retrying");
}
