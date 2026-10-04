import { extname } from "node:path";
import { HarmonyError } from "./errors";

export const MAX_DEVICE_MEDIA_PREVIEW_BYTES = 16 * 1024 * 1024;

export function deviceMediaMime(path: string, bytes: Buffer): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".wav" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (extension === ".ogg" && bytes.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (extension === ".mp3" && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return "audio/mpeg";
  if ([".mp4", ".m4v", ".m4a"].includes(extension) && bytes.toString("ascii", 4, 8) === "ftyp") return extension === ".m4a" ? "audio/mp4" : "video/mp4";
  if (extension === ".webm" && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  throw new HarmonyError("INVALID_RESPONSE", "Device file is not a supported WAV, Ogg, MP3, MP4 or WebM media file");
}

export function mediaByteRange(header: string | null, length: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw new HarmonyError("INVALID_ARGUMENT", "Unsupported media byte range");
  const suffix = !match[1] ? Number(match[2]) : null;
  const start = suffix === null ? Number(match[1]) : Math.max(0, length - suffix);
  const end = suffix === null ? (match[2] ? Number(match[2]) : length - 1) : length - 1;
  if ((suffix !== null && !Number.isSafeInteger(suffix)) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start >= length || end < start || suffix === 0) {
    throw new HarmonyError("INVALID_ARGUMENT", "Media byte range is outside the file");
  }
  return { start, end: Math.min(end, length - 1) };
}
