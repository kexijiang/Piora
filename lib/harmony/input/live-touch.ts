import type { TouchPhase } from "./gesture-channel";

type Point = { x: number; y: number };
type TouchTransport = { touch(phase: TouchPhase, x: number, y: number): Promise<unknown> };

/** One bounded gesture. The owner binds this to its lease, geometry and epoch.
 * Transport failure never retries DOWN/MOVE; a separate release may be attempted.
 */
export class LiveTouch {
  private active = false;
  private ended = false;
  private point?: Point;
  private latest?: Point;
  private watchdog?: ReturnType<typeof setTimeout>;
  private moving?: Promise<void>;
  private starting?: Promise<unknown>;
  private ending?: Promise<void>;

  constructor(private readonly transport: TouchTransport, private readonly options: {
    validate(point: Point): void;
    recoverRelease(point: Point): Promise<void>;
    onError(error: unknown): void;
    maxHoldMs?: number;
  }) {
    const limit = options.maxHoldMs ?? 2000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid gesture hold bound");
  }

  async down(point: Point): Promise<void> {
    if (this.active || this.ended) throw new Error("Gesture already started or ended");
    this.options.validate(point);
    this.active = true; this.point = { ...point };
    this.watchdog = setTimeout(() => { void this.up().catch(this.options.onError); }, this.options.maxHoldMs ?? 2000);
    this.starting = this.transport.touch("down", point.x, point.y);
    try { await this.starting; }
    catch (error) { await this.up().catch(this.options.onError); throw error; }
  }

  move(point: Point): Promise<void> {
    if (!this.active || this.ended) return Promise.reject(new Error("Gesture is not active"));
    try { this.options.validate(point); }
    catch (error) { void this.up().catch(this.options.onError); return Promise.reject(error); }
    this.latest = { ...point };
    // A slow device gets only the latest pending move; DOWN/UP are never dropped.
    if (!this.moving) this.moving = this.drain().finally(() => { this.moving = undefined; });
    return this.moving;
  }

  private async drain(): Promise<void> {
    try {
      await this.starting;
      while (this.latest && !this.ended) {
        const point = this.latest; this.latest = undefined;
        this.options.validate(point);
        this.point = point;
        await this.transport.touch("move", point.x, point.y);
      }
    } catch (error) {
      // Do not await UP here: UP drains this promise before releasing the pointer.
      void this.up().catch(this.options.onError);
      throw error;
    }
  }

  up(): Promise<void> {
    if (this.ending) return this.ending;
    this.ended = true; this.latest = undefined; clearTimeout(this.watchdog);
    this.ending = (async () => {
      if (!this.active || !this.point) return;
      await this.starting?.catch(() => undefined);
      await this.moving?.catch(() => undefined);
      const point = this.point;
      // UP must still execute if the lease/epoch/geometry was revoked after DOWN.
      try { await this.transport.touch("up", point.x, point.y); }
      catch { await this.options.recoverRelease(point); }
      finally { this.active = false; }
    })();
    return this.ending;
  }
}
