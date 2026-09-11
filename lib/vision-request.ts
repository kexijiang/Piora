import type { AssistantMessage } from "@earendil-works/pi-ai";

export const VISION_REQUEST_TIMEOUT_MS = 180_000;

/** Own the deadline so SDK abort messages cannot hide why we cancelled. */
export async function completeVisionRequest(
  complete: (signal: AbortSignal) => Promise<AssistantMessage>,
  parent?: AbortSignal,
): Promise<AssistantMessage> {
  const controller = new AbortController();
  const cancelled = () => controller.abort(new Error("视觉识别已取消。"));
  if (parent?.aborted) cancelled();
  else parent?.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error("视觉识别超时（3 分钟），模型未在时限内完成，请稍后重试。"));
  }, VISION_REQUEST_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const message = await Promise.race([complete(controller.signal), aborted]);
    controller.signal.throwIfAborted();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || (message.stopReason === "aborted" ? "Request was aborted" : "视觉模型识别失败。"));
    }
    return message;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof Error && (error.name === "AbortError" || /\b(?:request was aborted|request aborted|operation was aborted)\b/iu.test(error.message))) {
      throw new Error("视觉识别请求被中断，请检查模型渠道连接后重试。", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancelled);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
