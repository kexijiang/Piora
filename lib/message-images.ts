import type { AgentMessage, ImageContent } from "./types";
import type { Base64ImageAttachment } from "./image-attachments";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Accept both Pi's persisted/SSE format and the composer's optimistic format. */
export function getMessageImageSource(block: unknown): ImageContent["source"] | null {
  const image = record(block);
  if (image?.type !== "image") return null;
  const source = record(image.source);
  if (source?.type === "url" && typeof source.url === "string" && source.url) {
    return { type: "url", url: source.url };
  }
  if (source?.type === "base64" && typeof source.data === "string" && source.data) {
    return {
      type: "base64", data: source.data,
      media_type: typeof source.media_type === "string" && source.media_type ? source.media_type : "image/png",
    };
  }
  if (typeof image.data === "string" && image.data) {
    return {
      type: "base64", data: image.data,
      media_type: typeof image.mimeType === "string" && image.mimeType ? image.mimeType : "image/png",
    };
  }
  return null;
}

export function messageImageUrl(block: unknown): string {
  const source = getMessageImageSource(block);
  if (!source) return "";
  return source.type === "base64" ? `data:${source.media_type};base64,${source.data}` : source.url ?? "";
}

export interface VisionRetryPayload {
  message: string;
  images?: Array<Base64ImageAttachment & { previewUrl: string }>;
}

/** Read the user's original image bytes, without rewriting persisted history. */
export function getVisionRetryPayload(messages: readonly AgentMessage[]): VisionRetryPayload | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = (typeof message.content === "string" ? message.content : blocks
      .flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : [])
      .join("\n")).trim();
    const images = blocks.flatMap((block) => {
      const source = getMessageImageSource(block);
      if (source?.type !== "base64" || !source.data) return [];
      const mimeType = source.media_type ?? "image/png";
      return [{ data: source.data, mimeType, previewUrl: `data:${mimeType};base64,${source.data}` }];
    });
    if (text || images.length > 0) return { message: text, ...(images.length > 0 ? { images } : {}) };
  }
  return null;
}
