import type { UserMessage } from "./types";
import { getMessageImageSource, type VisionRetryPayload } from "./message-images";

/** Restore deferred text before resending, and keep both Pi and UI image formats. */
export async function prepareMessageRetry(message: UserMessage, loadText: () => Promise<string>): Promise<VisionRetryPayload & { files?: import("./draft-store").ChatDraftFile[] }> {
  if (message.recoveryDraft) {
    const draft = message.recoveryDraft;
    return { message: draft.value, files: draft.files, images: draft.images.map((image) => ({ ...image, previewUrl: `data:${image.mimeType};base64,${image.data}` })) };
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = message.deferredContent ? await loadText() : typeof message.content === "string" ? message.content
    : blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  const images = blocks.filter((block) => block.type === "image").map((block) => {
    const source = getMessageImageSource(block);
    if (source?.type !== "base64" || !source.data) throw new Error("无法读取原消息的图片附件，请重新添加图片后发送。");
    const mimeType = source.media_type ?? "image/png";
    return { data: source.data, mimeType, previewUrl: `data:${mimeType};base64,${source.data}` };
  });
  if (!text.trim() && !images.length) throw new Error("原消息没有可重试的内容。");
  return { message: text, ...(images.length ? { images } : {}) };
}
