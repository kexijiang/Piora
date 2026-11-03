import { MiniAppWorker } from "./worker-client";
import { MiniAppFrameHost } from "./frame-host";
import { miniAppEventRequest } from "./events";
import { compileMiniAppPlan, validateMiniAppCheckpoint, validateMiniAppResult, type CompiledMiniApp, type MiniAppResult } from "./plan";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import type { MiniAppCheckpoint, MiniAppVmRequest } from "./vm";
import type { JsonRecord } from "./json";
import { miniAppPlaybackMode, miniAppStepRequest, miniAppStepInterval } from "./playback";
import { MiniAppRepeatIdentity } from "./repeat";
import { isMiniAppError } from "./limits";
import { MiniAppSceneIdentity, validateMiniAppViewState, type MiniAppViewState } from "./scene-state";
import { boundedJson, exactKeys } from "./json";

interface ControllerOptions {
  playGroup?: string;
  snapshot?: MiniAppCheckpoint;
  signal?: AbortSignal;
  onChange(value: MiniAppResult, changed: boolean): void;
  onStatus(status: "paused" | "playing" | "stopped"): void;
  onError(error: MiniAppError): void;
}
type Operation = { kind: "event" | "camera"; event: JsonRecord } | { kind: "step" } | { kind: "reset"; acknowledged: number };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const playingInstances = new Map<string, MiniAppController>();

/** Owns local execution and scheduling. Persistence and permission stay outside. */
export class MiniAppController {
  private readonly cancellation = new AbortController();
  private readonly compiled: CompiledMiniApp;
  private worker?: MiniAppWorker;
  private frame?: MiniAppFrameHost;
  private current?: MiniAppResult;
  private readonly queue: Operation[] = [];
  private busy = false;
  private ended = false;
  private playing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private removeAbort?: () => void;
  private lastStepAt = 0;
  private checkpointing = false;
  private inputsBlocked = false;
  private readonly rowIdentity = new MiniAppRepeatIdentity();
  private rowRevision = 0;
  private rowAccepted = 0;
  private rowAcknowledged = 0;
  private readonly sceneIdentity = new MiniAppSceneIdentity();
  private sceneRevision = 0;
  private sceneEpoch = 0;
  private readonly idleWaiters = new Set<{ resolve(): void; reject(error: MiniAppError): void }>();

  private constructor(plan: unknown, private readonly options: ControllerOptions) {
    this.compiled = compileMiniAppPlan(plan);
  }

  static async create(container: HTMLElement, plan: unknown, options: ControllerOptions): Promise<MiniAppController> {
    const host = new MiniAppController(plan, options);
    const abort = () => host.stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    host.removeAbort = () => options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) { host.stop(); throw new MiniAppError("STOPPED", "Mini app was cancelled"); }
    try {
      host.worker = await MiniAppWorker.create(host.compiled.plan.program, { signal: host.cancellation.signal });
      const snapshot = options.snapshot ? validateMiniAppCheckpoint(host.compiled, options.snapshot)
        : { inputs: host.compiled.initialInputs, state: null, rng: 0x50494f52, tick: 0 };
      // Restore releases old gestures and projects once within the same bounded
      // startup operation. Separate project + blur would compile/project twice
      // and treat half of cold restoration as an ordinary 8ms input.
      const reply = await host.worker.run({ command: options.snapshot ? "restore" : "init", snapshot });
      host.current = validateMiniAppResult(host.compiled, reply);
      // A saved key/drag belongs to the old input realm. Restoring a checkpoint
      // is a focus-loss boundary, not permission to continue the old gesture.
      const restoredChanged = !!options.snapshot && JSON.stringify(host.current.snapshot) !== JSON.stringify(snapshot);
      host.frame = await MiniAppFrameHost.create(container, { signal: host.cancellation.signal,
        onEvent: event => host.interact(event), onError: error => host.fail(error) });
      if (host.compiled.plan.viewports.some(view => view.kind === "scene3d") && !(await host.frame.probeEnvironment()).webgl) {
        throw new MiniAppError("GRAPHICS_UNAVAILABLE", "This window cannot render the saved 3D scene; the checkpoint is retained");
      }
      if (host.ended) throw new MiniAppError("STOPPED", "Mini app was cancelled");
      host.frame.setDocument({ document: host.compiled.document, inputs: host.current.snapshot.inputs, viewports: host.compiled.plan.viewports,
        ...(host.current.snapshot.view ? { view: host.current.snapshot.view } : {}) });
      host.rowRevision = host.rowIdentity.publish(host.current.frame.repeats);
      host.sceneRevision = host.sceneIdentity.publish(host.current.frame.scenes);
      host.render();
      options.onChange(clone(host.current), restoredChanged); options.onStatus("paused");
      document.addEventListener("visibilitychange", host.visibility);
      window.addEventListener("blur", host.blur);
      return host;
    } catch (error) { host.stop(); throw error; }
  }

  get snapshot(): MiniAppCheckpoint | undefined { return this.current ? clone(this.current.snapshot) : undefined; }

  private render(): void {
    if (this.current) this.frame?.render(this.current.frame, this.current.snapshot.inputs, { revision: this.rowRevision, ack: this.rowAcknowledged, sceneRevision: this.sceneRevision, sceneEpoch: this.sceneEpoch });
  }

  private releaseInputs(): void {
    if (this.ended) return;
    this.pause();
    // The renderer flushes earlier moves on the same message port before blur.
    this.frame?.releaseInputs();
  }
  private readonly visibility = () => { if (document.hidden) this.releaseInputs(); };
  private readonly blur = () => {
    // Moving focus into our frame is ordinary interaction. The frame itself
    // forwards its blur when focus subsequently leaves it or the application.
    if (document.activeElement === this.frame?.iframe) return;
    this.releaseInputs();
  };

  interact(event: JsonRecord): void {
    if (this.ended || this.inputsBlocked || !this.current) return;
    try {
      if (event.type === "blur") this.pause();
      if (event.type === "scene-camera") {
        this.cameraView(event);
        const previous = this.queue.at(-1);
        if (previous?.kind === "camera" && previous.event.id === event.id) previous.event = clone(event);
        else this.enqueue({ kind: "camera", event: clone(event) });
        return;
      }
      if (event.type === "scene-pick") this.sceneIdentity.validate(event);
      if (event.type === "item-input" || event.type === "item-click") {
        this.rowIdentity.validate(event);
        if (!Number.isSafeInteger(event.serial) || (event.serial as number) <= this.rowAccepted) return;
      }
      if ((event.type === "scene-pick" || event.type === "input") && event.serial !== undefined
        && (!Number.isSafeInteger(event.serial) || (event.serial as number) <= this.rowAccepted)) return;
      const request = miniAppEventRequest(this.compiled, this.current.snapshot, event, this.current.frame);
      if (event.type === "item-input" || event.type === "item-click" || (event.type === "scene-pick" || event.type === "input") && typeof event.serial === "number") this.rowAccepted = event.serial as number;
      if (request.command === "step" || request.command === "preset") this.pause();
      const previous = this.queue.at(-1);
      // Coalesce only consecutive moves/inputs for the same target. Down/up,
      // keyboard transitions and clicks retain their original order.
      if ((event.type === "pointermove" || event.type === "input" || event.type === "item-input") && previous?.kind === "event"
        && previous.event.type === event.type && previous.event.id === event.id && previous.event.repeat === event.repeat && previous.event.key === event.key) previous.event = clone(event);
      else this.enqueue({ kind: "event", event: clone(event) });
    } catch (error) {
      if (isMiniAppError(error) && error.code === "STALE_EVENT") {
        if (Number.isSafeInteger(event.serial) && (event.serial as number) > this.rowAccepted) {
          this.rowAccepted = event.serial as number;
          // Acknowledge a rejected event in queue order. A later rejection must
          // not make a frame overwrite an earlier keystroke still being applied.
          this.enqueue({ kind: "event", event: clone(event) });
        }
        return;
      }
      this.fail(error);
    }
  }

  private cameraView(event: JsonRecord): MiniAppViewState {
    boundedJson(event, 3000, "event"); exactKeys(event, ["type", "id", "camera", "reset", "epoch"], "event");
    const id = event.id;
    if (typeof id !== "string") throw new MiniAppError("BINDING", "Camera event requires a declared viewport");
    const view = validateMiniAppViewState({ version: 1, cameras: { [id]: { reset: event.reset, camera: event.camera } } }, this.compiled.plan.viewports)!;
    if (event.epoch !== this.sceneEpoch || event.reset !== (this.current?.frame.scenes?.[id]?.cameraRevision ?? 0)) throw new MiniAppError("STALE_EVENT", "Camera gesture belongs to an old view");
    return { version: 1, cameras: { ...this.current?.snapshot.view?.cameras, ...view.cameras } };
  }

  private canStep(): boolean { return miniAppPlaybackMode(this.compiled.plan) !== "none" && !this.current?.frame.playback?.finished; }
  step(): void { if (this.checkpointing || !this.canStep()) return; this.pause(); this.enqueue({ kind: "step" }); }
  reset(): void { if (this.checkpointing) return; this.pause(); this.queue.length = 0; this.enqueue({ kind: "reset", acknowledged: this.rowAccepted }); }
  play(): void {
    if (this.ended || this.checkpointing || this.playing || document.hidden || !this.canStep()) return;
    const group = this.options.playGroup ?? "default";
    playingInstances.get(group)?.pause(); playingInstances.set(group, this);
    this.playing = true; this.options.onStatus("playing"); this.schedule();
  }
  pause(): void {
    const wasPlaying = this.playing; this.playing = false;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const group = this.options.playGroup ?? "default";
    if (playingInstances.get(group) === this) playingInstances.delete(group);
    if (wasPlaying && !this.ended) this.options.onStatus("paused");
  }

  /** Freeze native inputs, drain both message/compute queues, then run the save gate. */
  async withCheckpoint<T>(work: (snapshot: MiniAppCheckpoint) => Promise<T>): Promise<T> {
    if (!this.current) throw new MiniAppError("STATE", "Mini app has no checkpoint");
    if (this.checkpointing) throw new MiniAppError("BUSY", "Mini app is already saving a checkpoint");
    if (this.ended) return work(clone(this.current.snapshot));
    this.checkpointing = true; this.pause();
    try {
      await this.frame!.freezeInputs();
      this.inputsBlocked = true;
      if (this.busy || this.queue.length) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(new MiniAppError("WATCHDOG", "Mini app interactions did not settle")), 2500);
        const waiter = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error: MiniAppError) => { clearTimeout(timer); reject(error); } };
        this.idleWaiters.add(waiter);
      });
      if (this.ended) throw new MiniAppError("STOPPED", "Mini app stopped while preparing a checkpoint");
      return await work(clone(this.current.snapshot));
    } finally {
      this.inputsBlocked = false; this.checkpointing = false;
      if (!this.ended) this.frame?.resumeInputs();
    }
  }

  private schedule(): void {
    if (!this.playing || this.ended || this.timer || this.busy || this.queue.length) return;
    const delay = Math.max(0, miniAppStepInterval(this.compiled.plan) - (performance.now() - this.lastStepAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.playing && !this.ended) { this.lastStepAt = performance.now(); this.enqueue({ kind: "step" }); }
    }, delay);
  }

  private enqueue(operation: Operation): void {
    if (this.ended) return;
    if (this.queue.length >= MINI_APP_LIMITS.eventQueue) { this.fail(new MiniAppError("LIMIT", "Too many pending mini app interactions")); return; }
    this.queue.push(operation); void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy || this.ended || !this.worker || !this.current) return;
    const operation = this.queue.shift(); if (!operation) { this.schedule(); return; }
    this.busy = true;
    try {
      if (operation.kind === "camera") {
        const view = this.cameraView(operation.event);
        this.current = { ...this.current, snapshot: { ...this.current.snapshot, view } };
        this.options.onChange(clone(this.current), true);
        return;
      }
      if (operation.kind === "event" && operation.event.type === "scene-pick") this.sceneIdentity.validate(operation.event);
      if (operation.kind === "event" && (operation.event.type === "item-input" || operation.event.type === "item-click")) this.rowIdentity.validate(operation.event);
      const request: MiniAppVmRequest | undefined = operation.kind === "event" ? miniAppEventRequest(this.compiled, this.current.snapshot, operation.event, this.current.frame)
        : operation.kind === "reset" ? { command: "init", snapshot: { ...this.current.snapshot, state: null, tick: 0, rng: 0x50494f52 } }
          : miniAppStepRequest(this.compiled, this.current.snapshot);
      if (!request || request.command === "step" && !this.canStep()) return;
      if (operation.kind === "reset") delete request.snapshot.view;
      const result = validateMiniAppResult(this.compiled, await this.worker.run(request));
      if (this.ended) return;
      if (operation.kind === "reset") { this.rowIdentity.reset(); this.rowAcknowledged = operation.acknowledged; this.sceneIdentity.reset(); this.sceneEpoch++; }
      if (operation.kind === "event" && typeof operation.event.serial === "number") this.rowAcknowledged = operation.event.serial;
      this.current = result;
      this.rowRevision = this.rowIdentity.publish(result.frame.repeats);
      this.sceneRevision = this.sceneIdentity.publish(result.frame.scenes);
      this.render();
      if (result.frame.playback?.finished) this.pause();
      this.options.onChange(clone(result), true);
    } catch (error) {
      if (isMiniAppError(error) && error.code === "STALE_EVENT") {
        if (operation.kind === "event" && typeof operation.event.serial === "number") this.rowAcknowledged = operation.event.serial;
        this.render();
      } else this.fail(error);
    }
    finally {
      this.busy = false;
      if (!this.queue.length) { for (const waiter of this.idleWaiters) waiter.resolve(); this.idleWaiters.clear(); }
      if (!this.ended) void this.drain();
    }
  }

  private fail(error: unknown) {
    if (this.ended) return;
    this.stop();
    this.options.onError(error instanceof MiniAppError ? error : new MiniAppError("EXECUTION", "Mini app stopped; the last checkpoint is retained"));
  }
  stop(): void {
    if (this.ended) return;
    this.ended = true; this.pause(); this.queue.length = 0;
    for (const waiter of this.idleWaiters) waiter.reject(new MiniAppError("STOPPED", "Mini app checkpoint was cancelled"));
    this.idleWaiters.clear();
    this.cancellation.abort(); this.worker?.stop(); this.frame?.dispose();
    this.removeAbort?.(); this.removeAbort = undefined;
    document.removeEventListener("visibilitychange", this.visibility); window.removeEventListener("blur", this.blur);
    this.options.onStatus("stopped");
  }
}
