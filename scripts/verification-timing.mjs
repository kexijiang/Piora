import { appendFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

export function createVerificationTimings(scope, emit) {
  const record = emit ?? (async event => {
    console.log(JSON.stringify(event));
    const directory = process.env.PIORA_VERIFICATION_TIMINGS;
    if (directory) {
      await mkdir(resolve(directory), { recursive: true });
      await appendFile(join(resolve(directory), `${scope}-${process.pid}.ndjson`), `${JSON.stringify(event)}\n`);
    }
  });
  return {
    async measure(phase, action, details = {}) {
      const started = performance.now();
      const startedAt = new Date().toISOString();
      let status = "success";
      try { return await action(); }
      catch (error) { status = "failure"; throw error; }
      finally {
        await record({ type: "verification_timing", scope, phase, pid: process.pid, startedAt,
          finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), status, ...details });
      }
    },
  };
}
