import type { CompanionLibraryItem } from "./companion-store";

class TransferRequestError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

// Read the body once: an empty or interrupted reply is not an empty library.
export async function readTransferResponse(response: Response): Promise<CompanionLibraryItem[]> {
  const text = await response.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { /* Report the transport failure, not a JSON editor error. */ }
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!response.ok) {
    const detail = typeof record?.error === "string" && record.error.trim() ? record.error : null;
    throw new TransferRequestError(detail || `中转站服务暂时不可用（${response.status}），请稍后重试。`, response.status >= 500);
  }
  if (!record || !Array.isArray(record.items)) {
    throw new TransferRequestError("中转站响应不完整，请稍后重试。", true);
  }
  if (!record.items.every((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.title === "string" && typeof item.content === "string")) {
    throw new TransferRequestError("中转站返回的数据格式异常，请稍后重试。", true);
  }
  return record.items as CompanionLibraryItem[];
}

export async function requestTransferItems(method: "GET" | "POST" | "PATCH" = "GET", input?: unknown): Promise<CompanionLibraryItem[]> {
  // Only reads may retry automatically. A lost write response may already be on disk.
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch("/api/companion/library", {
        method, cache: "no-store", signal: AbortSignal.timeout(20_000),
        ...(method !== "GET" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
      });
      return await readTransferResponse(response);
    } catch (cause) {
      const transient = cause instanceof TransferRequestError ? cause.retryable : true;
      if (method === "GET" && transient && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }
      const message = cause instanceof TransferRequestError ? cause.message
        : cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name)
          ? "中转站请求超时，请稍后重试。" : "暂时无法连接中转站，请稍后重试。";
      throw new Error(method === "GET" || !transient ? message : `${message} 内容已保留；请先刷新列表确认是否已保存。`);
    }
  }
}
