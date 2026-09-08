import { spawn } from "node:child_process";
import { HarmonyError } from "./errors";

/** A cancellable, long-lived read. Unlike runCommand it never buffers a log session. */
export function streamHdcLines(executable: string, args: string[], onLines: (lines: string[]) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "", stderr = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", abort);
      child.kill();
      if (error && !signal?.aborted) reject(error); else resolve();
    };
    const abort = () => finish();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
      // A malformed device response must not grow an unlimited partial line.
      if (pending.length > 65_536) { lines.push(pending.slice(0, 65_536)); pending = ""; }
      try { if (lines.length) onLines(lines.map((line) => line.slice(0, 65_536))); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.on("error", (error) => finish(new HarmonyError("COMMAND_FAILED", `无法启动设备日志：${error.message}`, { retryable: true })));
    child.on("close", (code) => {
      if (settled) return;
      finish(new HarmonyError("COMMAND_FAILED", `设备日志连接已结束 (${code ?? "closed"})${stderr ? `: ${stderr}` : ""}`, { retryable: true }));
    });
  });
}
