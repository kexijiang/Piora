// Immutable conversation image receipts only. Upstream owns the editable library.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeAgentDataDirectory } from "./runtime-home.ts";
import { memeHttp } from "./dsh-meme-bridge.ts";
export function memeRoot() { return path.join(getRuntimeAgentDataDirectory(), "piora", "memes"); }
export async function captureMeme(url: string, caption: string): Promise<string> {
  if (!url.startsWith("/dsh-memes/") || url.includes("..") || url.includes("\\") || url.includes("#")) throw new Error("Invalid meme image URL");
  const response = await memeHttp(url);
  if (response.status !== 200 || response.bytes.length > 8 * 1024 * 1024) throw new Error("Meme image unavailable or too large");
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(response.bytes, { limitInputPixels: 40000000 }).metadata();
  if (!["png", "jpeg", "webp", "gif"].includes(metadata.format || "")) throw new Error("Unsupported meme image");
  const id = createHash("sha256").update(response.bytes).digest("hex");
  fs.mkdirSync(memeRoot(), { recursive: true });
  fs.writeFileSync(path.join(memeRoot(), id), response.bytes);
  const alt = caption.replace(/[\\\[\]<>\r\n]/g, " ").slice(0, 200);
  return `![${alt}](/api/memes/${id})`;
}
export function readMemeImage(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid meme id");
  const bytes = fs.readFileSync(path.join(memeRoot(), id));
  const mime = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg" : bytes.subarray(0, 4).toString() === "GIF8" ? "image/gif" : bytes.subarray(0, 4).toString() === "RIFF" ? "image/webp" : "image/png";
  return { bytes, mime };
}
