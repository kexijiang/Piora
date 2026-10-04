import { extname } from "node:path";
import { HarmonyError } from "./errors";

export const MAX_DEVICE_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;

export function deviceImageMime(path: string, bytes: Buffer): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if ([".jpg", ".jpeg"].includes(extension) && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (extension === ".gif" && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (extension === ".webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new HarmonyError("INVALID_RESPONSE", "Device file is not a supported PNG, JPEG, GIF or WebP image");
}
