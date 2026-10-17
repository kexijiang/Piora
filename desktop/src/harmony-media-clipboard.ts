import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

type MediaStorage = { screenshotDirectory: string; recordingDirectory: string };
type ClipboardOutput = { writeImage: (png: Buffer) => void | Promise<void>; writeFile: (path: string) => void | Promise<void> };

/** Only saved media in the server's configured directories may cross this bridge. */
export async function copyHarmonyMedia(value: unknown, storage: MediaStorage, output: ClipboardOutput): Promise<void> {
  const media = value as { kind?: unknown; path?: unknown } | null;
  if (!media || (media.kind !== "screenshot" && media.kind !== "recording")
    || typeof media.path !== "string" || media.path.length > 32_768 || media.path.includes("\0") || !isAbsolute(media.path)) {
    throw new Error("Invalid Harmony media");
  }
  const directory = media.kind === "screenshot" ? storage.screenshotDirectory : storage.recordingDirectory;
  const extension = media.kind === "screenshot" ? ".png" : ".mp4";
  if (typeof directory !== "string" || !isAbsolute(directory)
    || dirname(resolve(media.path)) !== resolve(directory) || extname(media.path).toLowerCase() !== extension) {
    throw new Error("Harmony media must be inside its configured storage directory");
  }
  const info = await lstat(media.path);
  const [canonicalPath, canonicalDirectory] = await Promise.all([realpath(media.path), realpath(directory)]);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || dirname(canonicalPath) !== canonicalDirectory) {
    throw new Error("Harmony media file is unavailable");
  }
  if (media.kind === "recording") {
    // Copy the file reference, never load a potentially large video into memory.
    await output.writeFile(canonicalPath);
    return;
  }
  if (info.size > 32 * 1024 * 1024) throw new Error("Harmony screenshot is too large to copy");
  const png = await readFile(canonicalPath);
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.readUInt32BE(16) * png.readUInt32BE(20) > 32_000_000) {
    throw new Error("Invalid Harmony screenshot");
  }
  await output.writeImage(png);
}
