import type { Logger } from "./logger.js";

/** Optional maintenance must not keep the startup window waiting indefinitely. */
export async function runOptionalStartupTask(name: string, task: () => Promise<void>, logger: Logger, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(task).catch(error => logger.warn(`${name} failed; continuing startup`, error));
  try {
    await Promise.race([
      work,
      new Promise<void>(resolve => {
        timer = setTimeout(() => {
          logger.warn(`${name} is still pending; continuing startup in the foreground`, { timeoutMs });
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
