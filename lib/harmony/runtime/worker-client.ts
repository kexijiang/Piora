import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { harmonyRuntimeAsset } from "./asset-path";
import { WORKER_PROTOCOL_VERSION } from "./worker-protocol";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { HarmonyError, type HarmonyErrorCode } from "../errors";
import type { HarmonySemanticActionRequest, HarmonySemanticActionResult } from "../types";
import type { HypiumAutomationStatus } from "../hypium-backend";

interface Worker { child: ChildProcess; pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>; epoch: string; status?: HypiumAutomationStatus }
export function workerEnvironment(hdcPath: string, source = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PIORA_HARMONY_WORKER_HDC: hdcPath, ELECTRON_RUN_AS_NODE: "1" };
  const key = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  env[key] = [dirname(hdcPath), source[key] ?? ""].join(delimiter);
  const runtime = source.PIORA_WEB_RUNTIME_ROOT?.trim();
  if (runtime?.endsWith(".asar")) env.NODE_PATH = [join(`${runtime}.unpacked`, "node_modules"), join(runtime, "node_modules"), source.NODE_PATH ?? ""].filter(Boolean).join(delimiter);
  return env;
}
/** No callbacks or live driver objects cross IPC; one owned child per physical device. */
export class HypiumWorkerClient {
  private workers = new Map<string, Worker>();
  private sequence = 0;
  constructor(private readonly hdcPath: string, private readonly entry = harmonyRuntimeAsset(".harmony-worker", "harmony", "runtime", "worker-entry.js"), private readonly timeoutMs = 45_000) {}
  private worker(serial: string): Worker {
    const existing = this.workers.get(serial); if (existing) return existing;
    if (!existsSync(this.entry)) throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Harmony driver worker is not built", { details: { dispatchState: "not-sent" } });
    const epoch = randomUUID();
    const child = spawn(process.execPath, [this.entry], { env: { ...workerEnvironment(this.hdcPath), PIORA_HARMONY_WORKER_EPOCH: epoch, PIORA_HARMONY_WORKER_SERIAL: serial }, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    const worker: Worker = { child, pending: new Map(), epoch };
    this.workers.set(serial, worker);
    child.on("message", (message: { protocol: number; epoch: string; status?: HypiumAutomationStatus; id: number; value?: unknown; error?: { code: HarmonyErrorCode; message: string; details?: Record<string, unknown>; retryable?: boolean } }) => {
      if (message?.protocol !== WORKER_PROTOCOL_VERSION || message.epoch !== worker.epoch) return;
      const pending = worker.pending.get(message.id); if (!pending) return;
      worker.pending.delete(message.id); worker.status = message.status?.serial === serial ? message.status : undefined;
      if (message.error) pending.reject(new HarmonyError(message.error.code, message.error.message, message.error)); else pending.resolve(message.value);
    });
    const lost = () => {
      if (this.workers.get(serial) === worker) this.workers.delete(serial);
      for (const pending of worker.pending.values()) pending.reject(new HarmonyError("AUTOMATION_DRIVER_FAILED", "Device worker exited; do not replay a potentially dispatched action", { details: { dispatchState: "unknown", effect: "unknown" } }));
      worker.pending.clear();
    };
    child.once("error", lost); child.once("exit", lost);
    return worker;
  }
  private async call(serial: string, method: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Worker request cancelled", { details: { dispatchState: "not-sent" } });
    const worker = this.worker(serial); const id = ++this.sequence;
    return await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.pending.delete(id); };
      const fail = (code: HarmonyErrorCode, message: string) => { cleanup(); worker.child.kill(); reject(new HarmonyError(code, message, { details: { dispatchState: "unknown", effect: "unknown" } })); };
      const abort = () => fail("COMMAND_ABORTED", "Worker request cancelled; physical effect is uncertain");
      const timer = setTimeout(() => fail("COMMAND_TIMEOUT", "Device worker timed out; inspect device state before retrying"), this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      worker.pending.set(id, { resolve(value) { cleanup(); resolve(value); }, reject(error) { cleanup(); reject(error); } });
      worker.child.send({ protocol: WORKER_PROTOCOL_VERSION, epoch: worker.epoch, deadline: Date.now() + this.timeoutMs, id, method, serial, args }, error => { if (error) fail("AUTOMATION_DRIVER_FAILED", "Device worker IPC failed"); });
    });
  }
  async execute(serial: string, operation: string, args: unknown[], signal?: AbortSignal) {
    try { return await this.call(serial, "execute", [operation, args], signal) as { used: true; value: unknown } | { used: false }; }
    catch (error) { if (error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_UNAVAILABLE") return { used: false as const }; throw error; }
  }
  async semanticAction(serial: string, request: HarmonySemanticActionRequest, signal?: AbortSignal) { return await this.call(serial, "semantic", [request], signal) as HarmonySemanticActionResult; }
  async waitForIdle(serial: string, idleMs: number, timeoutMs: number, signal?: AbortSignal) {
    try { return await this.call(serial, "idle", [idleMs, timeoutMs], signal) as boolean; }
    catch (error) { if (error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_UNAVAILABLE") return false; throw error; }
  }
  status(): HypiumAutomationStatus[] { return [...this.workers].map(([serial, worker]) => (worker.status ?? { serial, state: "connecting" })); }
  async invalidate(serial: string): Promise<void> {
    const worker = this.workers.get(serial); if (!worker) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new HarmonyError("DEVICE_BUSY", "Worker termination is uncertain")), 1500);
      worker.child.once("exit", () => { clearTimeout(timer); resolve(); });
      // An idle worker can close its own RPC forwarding rules on IPC disconnect.
      // A running/ambiguous action must still be interrupted immediately.
      if (worker.pending.size === 0 && worker.child.connected) worker.child.disconnect();
      else worker.child.kill();
    });
  }
  async reset(serial?: string): Promise<void> { await Promise.all((serial ? [serial] : [...this.workers.keys()]).map(value => this.invalidate(value))); }
}
