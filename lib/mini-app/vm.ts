import { QuickJS, Intrinsics, type JSValueHandle } from "quickjs-wasi";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import { boundedJson, type JsonRecord, type JsonValue } from "./json";
import { miniAppProgramFactory } from "./program";
import { MINI_APP_GUEST_RUNTIME } from "./guest-runtime";
import { limitMiniAppWasmMemory } from "./wasm-memory";
import type { MiniAppViewState } from "./scene-state";

export interface MiniAppCheckpoint { inputs: JsonRecord; state: JsonValue; rng: number; tick: number; view?: MiniAppViewState }
export interface MiniAppVmReply { snapshot: MiniAppCheckpoint; frame: JsonRecord }
export interface MiniAppVmRequest {
  command: "init" | "restore" | "event" | "step" | "project" | "preset" | "migrate";
  snapshot: MiniAppCheckpoint;
  /** For step, a validated discrete button event replaces continuous advance. */
  event?: JsonRecord;
  /** Only the server migration worker enables this entry; never a renderer event. */
  previous?: MiniAppCheckpoint;
}

/** Never construct this on the UI thread or a shared server request thread. */
export class MiniAppVm {
  private runtime?: QuickJS;
  private invoke?: JSValueHandle;
  private factory?: JSValueHandle;
  private deadline = 0;
  private interrupted = false;
  private stopped = false;
  private hasExecuted = false;
  private recent: Array<{ at: number; elapsed: number }> = [];

  private constructor(private readonly now: () => number, private readonly migration: boolean) {}

  static async create(wasm: Uint8Array, source: string, now: () => number = () => performance.now(), migration = false): Promise<MiniAppVm> {
    const factory = miniAppProgramFactory(source, migration);
    const host = new MiniAppVm(now, migration);
    const bounded = limitMiniAppWasmMemory(wasm);
    const wasmModule = await WebAssembly.compile(bounded as Uint8Array<ArrayBuffer>);
    if (WebAssembly.Module.imports(wasmModule).some(item => item.kind === "memory")) throw new MiniAppError("RUNTIME", "Imported memory is not permitted");
    const options = { wasm: wasmModule, memoryLimit: MINI_APP_LIMITS.heapBytes,
      maxStackSize: MINI_APP_LIMITS.stackBytes, timezoneOffset: 0,
      intrinsics: Intrinsics.JSON | Intrinsics.REGEXP | Intrinsics.MAP_SET | Intrinsics.TYPED_ARRAYS,
      interruptHandler: () => {
        if (host.stopped || host.now() >= host.deadline) host.interrupted = true;
        return host.interrupted;
      },
    };
    let compiler: QuickJS | undefined;
    try {
      host.deadline = now() + MINI_APP_LIMITS.initializationMs;
      // QuickJS's host source compiler also needs EVAL. Compile without executing
      // in a disposable VM; the execution VM never enables dynamic compilation.
      compiler = await QuickJS.create({ ...options, intrinsics: options.intrinsics | Intrinsics.EVAL });
      const prelude = compiler.compile(MINI_APP_GUEST_RUNTIME, "piora-mini-app-runtime");
      const bytecode = compiler.compile(factory, "mini-app-program");
      compiler.dispose(); compiler = undefined;
      host.runtime = await QuickJS.create(options);
      host.invoke = host.runtime.evalBytecode(prelude);
      host.factory = host.runtime.evalBytecode(bytecode);
      return host;
    } catch (error) { host.dispose(); throw host.failure(error); }
    finally { compiler?.dispose(); }
  }

  private failure(error: unknown): MiniAppError {
    // Never stringify guest values or expose a generated stack as a host diagnostic.
    if (error && typeof error === "object" && "dispose" in error && typeof error.dispose === "function") error.dispose();
    return new MiniAppError(this.interrupted ? "TIME_LIMIT" : "EXECUTION", this.interrupted ? "Mini app exceeded its execution budget" : "Mini app execution failed");
  }

  run(request: MiniAppVmRequest): MiniAppVmReply {
    if (this.stopped || !this.runtime || !this.invoke || !this.factory) throw new MiniAppError("STOPPED", "Mini app is stopped");
    if (!["init", "restore", "event", "step", "project", "preset", "migrate"].includes(request.command)
      || !Number.isSafeInteger(request.snapshot.tick) || request.snapshot.tick < 0 || request.snapshot.tick >= Number.MAX_SAFE_INTEGER
      || !Number.isInteger(request.snapshot.rng) || request.snapshot.rng < 0 || request.snapshot.rng > 0xffffffff) {
      throw new MiniAppError("STATE", "Invalid checkpoint identity");
    }
    const serialized = boundedJson(request, MINI_APP_LIMITS.replyBytes);
    if (request.command === "migrate" && (!this.migration || !request.previous || this.hasExecuted)) throw new MiniAppError("STATE", "Progress migration is a server-owned startup operation");
    const started = this.now();
    this.recent = this.recent.filter(item => started - item.at < 1_000);
    if (this.recent.reduce((sum, item) => sum + item.elapsed, 0) >= MINI_APP_LIMITS.cpuWindowMs) {
      throw new MiniAppError("CPU_LIMIT", "Pause before continuing this mini app");
    }
    this.interrupted = false;
    // A restored VM's first projection is its startup operation, just as init is
    // for a new program. It must not call init or alter the saved state to warm up.
    // Consume the allowance before invoking guest code, including failed attempts.
    const startup = request.command === "init" || (!this.hasExecuted && ["project", "restore", "migrate"].includes(request.command));
    this.hasExecuted = true;
    this.deadline = started + (startup ? MINI_APP_LIMITS.initializationMs : MINI_APP_LIMITS.operationMs);
    let argument: JSValueHandle | undefined, result: JSValueHandle | undefined;
    try {
      argument = this.runtime.newString(serialized);
      result = this.runtime.callFunction(this.invoke, this.runtime.undefined, this.factory, argument);
      if (!result.isString || result.length > MINI_APP_LIMITS.replyBytes) throw new MiniAppError("LIMIT", "Invalid runtime reply");
      const reply = JSON.parse(result.toString()) as MiniAppVmReply;
      // The generated program sees task data only. Preserve host-owned camera
      // state outside its VM result; plan/result validation checks it separately.
      if (request.snapshot.view !== undefined) reply.snapshot.view = JSON.parse(JSON.stringify(request.snapshot.view));
      boundedJson(reply, MINI_APP_LIMITS.replyBytes);
      if (!reply.frame || typeof reply.frame !== "object" || Array.isArray(reply.frame)) throw new MiniAppError("FRAME", "Expected a frame object");
      return reply;
    } catch (error) {
      if (error instanceof MiniAppError) throw error;
      throw this.failure(error);
    } finally {
      result?.dispose(); argument?.dispose();
      this.recent.push({ at: started, elapsed: this.now() - started });
    }
  }

  memoryUsage() {
    if (!this.runtime || this.stopped) throw new MiniAppError("STOPPED", "Mini app is stopped");
    return this.runtime.getMemoryUsage();
  }

  dispose(): void {
    this.stopped = true;
    this.factory?.dispose(); this.invoke?.dispose(); this.runtime?.dispose();
    this.factory = this.invoke = undefined;
    this.runtime = undefined;
  }
}
