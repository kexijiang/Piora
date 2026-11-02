import { MiniAppError } from "./limits";

/** Limit the bytes as they arrive; Content-Length is only an early rejection. */
export async function readMiniAppResource(response: Response, maximum: number, options: { allowErrorStatus?: boolean } = {}): Promise<Uint8Array<ArrayBuffer>> {
  if ((!response.ok && !options.allowErrorStatus) || !response.body) throw new MiniAppError("RUNTIME", "Mini app resource is unavailable");
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel();
    throw new MiniAppError("LIMIT", "Mini app resource exceeds its byte budget");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new MiniAppError("LIMIT", "Mini app resource exceeds its byte budget");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
