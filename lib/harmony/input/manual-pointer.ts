import { LiveTouch } from "./live-touch";
import type { TouchPhase } from "./gesture-channel";

type Point = { x: number; y: number };

/** Keeps the device lane occupied from DOWN until confirmed UP, including cancellation. */
export class ManualPointer {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private readonly released: Promise<void>;
  private finish!: () => void;
  private failure?: unknown;
  private readonly touch: LiveTouch;

  constructor(options: {
    dispatch(phase: TouchPhase, point: Point): Promise<void>;
    validate(point: Point): void;
    maxHoldMs?: number;
  }) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.released = new Promise(resolve => { this.finish = resolve; });
    this.touch = new LiveTouch({ touch: async (phase, x, y) => {
      try { await options.dispatch(phase, { x, y }); }
      catch (error) { this.failure ??= error; throw error; }
      finally { if (phase === "up") this.finish(); }
    } }, {
      validate: options.validate, maxHoldMs: options.maxHoldMs ?? 9000,
      // The device worker owns transport recovery. A failed release is not replayed here.
      recoverRelease: async () => { throw this.failure ?? new Error("Pointer release failed"); },
      onError: error => { this.failure ??= error; this.finish(); },
    });
  }

  async run(point: Point, signal: AbortSignal): Promise<void> {
    const abort = () => { void this.touch.up().catch(error => { this.failure ??= error; this.finish(); }); };
    try {
      if (signal.aborted) throw new Error("Pointer cancelled before dispatch");
      signal.addEventListener("abort", abort, { once: true });
      await this.touch.down(point);
      this.resolveReady();
      await this.released;
      if (this.failure) throw this.failure;
    } catch (error) { this.rejectReady(error); throw error; }
    finally { signal.removeEventListener("abort", abort); await this.touch.up(); }
  }

  move(point: Point): Promise<void> { return this.touch.move(point); }
  up(): Promise<void> { return this.touch.up(); }
}
