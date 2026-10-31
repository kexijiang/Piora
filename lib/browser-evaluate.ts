import type { Page } from "playwright-core";

export const BROWSER_EVALUATE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;

/** Playwright's default action timeout does not cover page.evaluate. */
export function evaluateBrowserPage(
  page: Page,
  expression: string,
  options: { signal?: AbortSignal; onInterrupted: () => void; timeoutMs?: number },
): Promise<unknown> {
  const { signal, onInterrupted, timeoutMs = BROWSER_EVALUATE_TIMEOUT_MS } = options;
  if (signal?.aborted) return Promise.reject(new Error("Browser action aborted"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const interrupt = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Quarantine synchronously, before a new tool can reuse this page. Closing
      // the target destroys both pending promises and CPU-bound script contexts.
      onInterrupted();
      let closeTimer: ReturnType<typeof setTimeout>;
      const closeDeadline = new Promise<never>((_, fail) => {
        closeTimer = setTimeout(() => fail(new Error("tab close timed out")), CLOSE_TIMEOUT_MS);
      });
      Promise.race([page.close({ runBeforeUnload: false }), closeDeadline]).then(
        () => reject(new Error(`${reason}; the executing browser tab was closed`)),
        () => reject(new Error(`${reason}; the executing browser tab was detached, but closing it could not be confirmed`)),
      ).finally(() => clearTimeout(closeTimer));
    };
    const abort = () => interrupt("Browser action aborted");
    const timer = setTimeout(() => interrupt("Browser evaluate timed out"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    // Observe late resolution/rejection, but never report a cancelled result.
    page.evaluate((source) => globalThis.eval(source), expression).then(
      (value: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
