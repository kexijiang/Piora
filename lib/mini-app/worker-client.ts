import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import { boundedJson } from "./json";
import { readMiniAppResource } from "./resource";
import type { MiniAppVmReply, MiniAppVmRequest } from "./vm";

interface Pending {
  sequence: number;
  resolve(value: MiniAppVmReply | undefined): void;
  reject(error: MiniAppError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns the kill switch outside generated execution. Never exposes this object to a frame. */
export class MiniAppWorker {
  private readonly worker: Worker;
  private readonly epoch = crypto.randomUUID();
  private sequence = 0;
  private ended = false;
  private pending?: Pending;
  private cleanup?: () => void;
  private constructor() {
    this.worker = new Worker(new URL("./runtime-worker.ts", import.meta.url), { type: "module", name: "piora-mini-app" });
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.onerror = event => { event.preventDefault(); this.stop(new MiniAppError("WORKER", "Mini app worker failed")); };
    this.worker.onmessageerror = () => this.stop(new MiniAppError("WORKER", "Mini app worker message could not be read"));
  }

  static async create(program: string, options: { wasm?: Uint8Array; signal?: AbortSignal } = {}): Promise<MiniAppWorker> {
    if (options.signal?.aborted) throw new MiniAppError("STOPPED", "Mini app was cancelled");
    let wasm = options.wasm;
    if (!wasm) {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const response = await fetch("/api/mini-app/runtime?version=3.6.2", { signal, cache: "force-cache" });
      wasm = await readMiniAppResource(response, 8 * 1024 * 1024);
    }
    if (wasm.byteLength > 8 * 1024 * 1024 || options.signal?.aborted) throw new MiniAppError("STOPPED", "Mini app cannot start");
    const host = new MiniAppWorker();
    const abort = () => host.stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    host.cleanup = () => options.signal?.removeEventListener("abort", abort);
    try {
      const ready = host.wait(0, 5_000);
      const copy = new Uint8Array(wasm).buffer;
      host.worker.postMessage({ type: "boot", epoch: host.epoch, wasm: copy, program }, [copy]);
      await ready;
      return host;
    } catch (error) { host.stop(); throw error; }
  }

  private wait(sequence: number, milliseconds: number): Promise<MiniAppVmReply | undefined> {
    if (this.ended) return Promise.reject(new MiniAppError("STOPPED", "Mini app is stopped"));
    if (this.pending) return Promise.reject(new MiniAppError("BUSY", "Wait for the current mini app operation"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new MiniAppError("WATCHDOG", "Mini app did not respond in time")), milliseconds);
      this.pending = { sequence, resolve, reject, timer };
    });
  }

  private receive(message: unknown): void {
    if (this.ended || !message || typeof message !== "object") return;
    const value = message as Record<string, unknown>, pending = this.pending;
    if (!pending || value.epoch !== this.epoch || value.seq !== pending.sequence) return;
    if (value.type === "error") {
      const code = typeof value.code === "string" && /^[A-Z_]{1,32}$/.test(value.code) ? value.code : "EXECUTION";
      this.stop(new MiniAppError(code, "Mini app stopped; the last acknowledged checkpoint is retained"));
      return;
    }
    if (pending.sequence === 0 && value.type === "ready") {
      clearTimeout(pending.timer); this.pending = undefined; pending.resolve(undefined); return;
    }
    if (value.type !== "result" || typeof value.reply !== "string" || value.reply.length > MINI_APP_LIMITS.replyBytes) {
      this.stop(new MiniAppError("PROTOCOL", "Invalid mini app response")); return;
    }
    try {
      const reply = JSON.parse(value.reply) as MiniAppVmReply;
      boundedJson(reply, MINI_APP_LIMITS.replyBytes);
      if (!reply.snapshot || !reply.frame) throw new Error("Invalid response");
      clearTimeout(pending.timer); this.pending = undefined; pending.resolve(reply);
    } catch { this.stop(new MiniAppError("PROTOCOL", "Invalid mini app response")); }
  }

  async run(request: MiniAppVmRequest): Promise<MiniAppVmReply> {
    if (this.ended) throw new MiniAppError("STOPPED", "Mini app is stopped");
    if (this.pending) throw new MiniAppError("BUSY", "Wait for the current mini app operation");
    const serialized = boundedJson(request, MINI_APP_LIMITS.replyBytes);
    const sequence = ++this.sequence;
    const result = this.wait(sequence, MINI_APP_LIMITS.watchdogMs);
    try { this.worker.postMessage({ type: "run", epoch: this.epoch, seq: sequence, request: serialized }); }
    catch { this.stop(new MiniAppError("WORKER", "Mini app request could not be sent")); }
    return await result as MiniAppVmReply;
  }

  stop(reason = new MiniAppError("STOPPED", "Mini app is stopped")): void {
    if (this.ended) return;
    this.ended = true;
    this.cleanup?.(); this.cleanup = undefined;
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    this.worker.terminate();
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(reason); }
  }
}
