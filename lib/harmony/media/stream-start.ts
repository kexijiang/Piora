import { HarmonyError, isHarmonyError } from "../errors";
import type { HarmonyVideoConnection } from "../types";

/** Fail before committing binary HTTP headers, so startup failures remain readable JSON. */
export async function prepareVideoStream(connection: HarmonyVideoConnection, signal: AbortSignal, timeoutMs = 8000): Promise<ReadableStream<Uint8Array>> {
  const reader = connection.stream.getReader();
  let rejectStart: (reason: unknown) => void = () => {};
  let closing: Promise<void> | undefined;
  const failure = new Promise<never>((_, reject) => { rejectStart = reject; });
  const abort = () => rejectStart(new HarmonyError("COMMAND_ABORTED", "Video connection cancelled"));
  const close = () => closing ??= (async () => {
    await Promise.allSettled([reader.cancel(), connection.close()]);
    reader.releaseLock();
  })();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => rejectStart(new HarmonyError("CAPABILITY_UNAVAILABLE", "The phone video service did not send data. Enable live video and confirm screen sharing on the phone.", { details: { reason: "mirror-awaiting-video" }, retryable: true })), timeoutMs);
  try {
    if (signal.aborted) abort();
    let first = await Promise.race([reader.read(), failure]);
    while (!first.done && !first.value?.length) first = await Promise.race([reader.read(), failure]);
    if (first.done) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The phone video connection closed before streaming began. Re-enable screen sharing and reconnect.", { details: { reason: "mirror-stream-closed" }, retryable: true });
    return new ReadableStream({
      start(controller) { controller.enqueue(first.value!); },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); await close(); }
          else controller.enqueue(next.value);
        } catch (error) { controller.error(error); await close(); }
      },
      cancel: close,
    }, { highWaterMark: 0 });
  } catch (error) {
    await close();
    if (isHarmonyError(error)) throw error;
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The phone video connection failed before streaming began. Re-enable screen sharing and reconnect.", { details: { reason: "mirror-stream-closed" }, retryable: true, cause: error });
  }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
