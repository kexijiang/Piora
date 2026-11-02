import sharp from "sharp";
import { getBase64DecodedByteLength, MAX_ATTACHED_IMAGE_BYTES } from "./image-attachments";

// Conservative cross-provider transport budgets, separate from original-file storage.
export const MODEL_IMAGE_MAX_EDGE = 1568;
export const MODEL_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const MODEL_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
type ImageBlock = { type: "image"; data: string; mimeType: string; [key: string]: unknown };
type PreparedImage = { image: ImageBlock; note?: string };
export type ModelImageCache = WeakMap<object, { maxBytes: number; value: Promise<PreparedImage> }>;

async function prepareImage(image: ImageBlock, maxBytes: number): Promise<PreparedImage> {
  const size = typeof image.data === "string" ? getBase64DecodedByteLength(image.data) : null;
  if (!size || size > MAX_ATTACHED_IMAGE_BYTES) throw new Error("图片数据无效或超过附件大小限制，请重新附加图片。");
  const bytes = Buffer.from(image.data, "base64");
  const input = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "warning" });
  const metadata = await input.metadata();
  if (!metadata.width || !metadata.height) throw new Error("无法读取图片尺寸，请重新附加有效图片。");
  const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 0);
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;
  const pipeline = (edge: number) => input.clone().rotate().resize(edge, edge, { fit: "inside", withoutEnlargement: true }).toColourspace("srgb");
  // Fully decode, auto-orient and encode; metadata alone cannot detect truncated images.
  let mimeType = metadata.format === "jpeg" ? "image/jpeg" : "image/png";
  let output = await (mimeType === "image/jpeg" ? pipeline(MODEL_IMAGE_MAX_EDGE).jpeg({ quality: 90 }) : pipeline(MODEL_IMAGE_MAX_EDGE).png()).toBuffer({ resolveWithObject: true });
  let flattened = false;
  if (output.data.length > maxBytes) {
    mimeType = "image/jpeg";
    flattened = metadata.hasAlpha === true;
    for (const [edge, quality] of [[1568, 85], [1568, 70], [1280, 70], [1024, 65], [768, 60]]) {
      output = await pipeline(edge).flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
      if (output.data.length <= maxBytes) break;
    }
  }
  if (output.data.length > maxBytes) throw new Error("图片压缩后仍超过本轮发送限额，请减少图片数量或裁剪后重试。");
  const notes: string[] = [];
  if (output.info.width !== width || output.info.height !== height) notes.push(`Image resized for this request: original ${width}x${height}, sent ${output.info.width}x${output.info.height}. Map coordinates back using x * ${(width / output.info.width).toFixed(4)}, y * ${(height / output.info.height).toFixed(4)}. The original remains in the chat record.`);
  if ((metadata.pages ?? 1) > 1) notes.push("Only the first frame/page of this image is included in this request.");
  if (flattened) notes.push("Transparency was composited on white for this request.");
  return { image: { ...image, data: output.data.toString("base64"), mimeType }, ...(notes.length ? { note: `[${notes.join(" ")}]` } : {}) };
}

/** Transform only the outgoing copy: user/tool images remain intact in persisted history. */
export async function prepareModelImageContext<T>(messages: readonly T[], signal?: AbortSignal, cache: ModelImageCache = new WeakMap()): Promise<T[]> {
  signal?.throwIfAborted();
  const contents = messages.map(message => {
    const entry = message as { role?: string; content?: unknown } | null;
    return entry && ["user", "toolResult", "custom"].includes(entry.role ?? "") && Array.isArray(entry.content) ? entry.content : null;
  });
  const count = contents.reduce((total, content) => total + (content?.filter(block => block?.type === "image").length ?? 0), 0);
  if (!count) return [...messages];
  // Providers have different count limits. Bound transport bytes without imposing
  // an arbitrary global count cap on user attachments or tool-loop images.
  const maxBytes = Math.min(MODEL_IMAGE_MAX_BYTES, Math.floor(MODEL_IMAGE_TOTAL_BYTES / count));
  const result: T[] = [];
  let imageIndex = 0;
  for (let index = 0; index < messages.length; index++) {
    const content = contents[index];
    if (!content?.some(block => block?.type === "image")) { result.push(messages[index]); continue; }
    const prepared: unknown[] = [];
    for (const block of content) {
      signal?.throwIfAborted();
      if (block?.type !== "image") { prepared.push(block); continue; }
      imageIndex++;
      try {
        let cached = cache.get(block);
        if (!cached || cached.maxBytes !== maxBytes) {
          cached = { maxBytes, value: prepareImage(block, maxBytes) };
          cache.set(block, cached);
        }
        const value = await cached.value;
        signal?.throwIfAborted();
        if (value.note) prepared.push({ type: "text", text: value.note });
        prepared.push(value.image);
      } catch (error) {
        cache.delete(block);
        signal?.throwIfAborted();
        const detail = error instanceof Error && /^[\u4e00-\u9fff]/u.test(error.message) ? error.message : "无法解码，图片可能损坏或格式不受支持，请转换为 PNG/JPEG 后重试。";
        throw new Error(`第 ${imageIndex} 张图片发送失败：${detail}`);
      }
    }
    result.push({ ...messages[index], content: prepared });
  }
  return result;
}
