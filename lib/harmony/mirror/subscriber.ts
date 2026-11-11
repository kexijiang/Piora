import { MIRROR_PROFILE } from "./profile";

type Entry = { packet: Uint8Array; at: number };
type Options = { recording: boolean; requestKeyframe(): void; onClose(): void; now?: () => number };

/** Each viewer owns a bounded queue. Discard a whole GOP, never a reference frame alone. */
export class MirrorSubscriber {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private queue: Entry[] = [];
  private bytes = 0;
  private demand = false;
  private closed = false;
  private needsKey = true;
  private configuration?: Uint8Array;
  private readonly now: () => number;
  dropped = 0;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now());
    this.stream = new ReadableStream({
      start: controller => { this.controller = controller; },
      pull: () => { this.demand = true; this.drain(); },
      cancel: () => this.close(),
    }, { highWaterMark: 0 });
    if (options.recording) this.enqueue(Uint8Array.from([0, 0, 0, 0x21, 0, 0, 0, 1, 1]));
  }

  push(packet: Uint8Array): void {
    if (this.closed) return;
    const type = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0);
    if (type === 2) {
      this.configuration = packet;
      this.needsKey = true;
      if (!this.options.recording) this.clear();
      this.enqueue(packet);
      this.options.requestKeyframe();
      return;
    }
    if (type !== 3) return;
    const key = Boolean(packet[8] & 1);
    if (!this.options.recording && this.overdue(packet.byteLength)) this.resync();
    if (this.needsKey && !key) { this.options.requestKeyframe(); return; }
    if (this.options.recording && this.bytes + packet.byteLength > MIRROR_PROFILE.maxViewerBytes) {
      this.close(new Error("Recording storage could not keep up with the encoded video"));
      return;
    }
    if (packet.byteLength > MIRROR_PROFILE.maxViewerBytes) {
      this.close(new Error("Encoded video frame exceeds the buffer limit"));
      return;
    }
    this.needsKey = false;
    this.enqueue(packet);
  }

  private overdue(incoming = 0): boolean {
    return this.queue.length >= MIRROR_PROFILE.maxViewerPackets
      || this.bytes + incoming > MIRROR_PROFILE.maxViewerBytes
      || Boolean(this.queue.length && this.now() - this.queue[0].at > MIRROR_PROFILE.maxViewerAgeMs);
  }

  private clear(): void { this.dropped += this.queue.filter(item => item.packet[3] === 3).length; this.queue = []; this.bytes = 0; }

  private resync(): void {
    this.clear(); this.needsKey = true;
    if (this.configuration) this.enqueue(this.configuration);
    this.options.requestKeyframe();
  }

  private enqueue(packet: Uint8Array): void {
    this.queue.push({ packet, at: this.now() }); this.bytes += packet.byteLength;
    this.drain();
  }

  private drain(): void {
    if (!this.demand || this.closed || !this.queue.length) return;
    // A viewer resuming after a pause must not paint the retained old GOP.
    if (!this.options.recording && !this.needsKey && this.overdue()) this.resync();
    const next = this.queue.shift();
    if (!next) return;
    this.bytes -= next.packet.byteLength; this.demand = false;
    this.controller.enqueue(next.packet);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true; this.clear();
    try { if (error) this.controller.error(error); else this.controller.close(); } catch { /* Reader already cancelled. */ }
    this.options.onClose();
  }
}
