import { VideoPacketReader, VIDEO_CONFIG, VIDEO_FRAME, parseVideoConfiguration, avcCodec, avcKeyframe, annexB, type VideoConfiguration } from "./protocol";
import type { MirrorStatistics, MirrorWorkerEvent } from "./messages";
import { HarmonyRequestError } from "../request-error";

type Attempt = { id: number; abort: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; watchdog?: ReturnType<typeof setTimeout>; failure?: Error; submitted: number; decoded: number };
class VideoRequestError extends HarmonyRequestError {
  constructor(readonly value: unknown, status: number) { super(value, status); }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs entirely in a dedicated worker: transport, parsing, decode and presentation. */
export class MirrorVideoEngine {
  private readonly lifetime = new AbortController();
  private attempt?: Attempt;
  private nextAttempt = 0;
  private decoder?: VideoDecoder;
  private decoderConfig?: VideoDecoderConfig;
  private config?: VideoConfiguration;
  private decoderEpoch = 0;
  private needsKey = true;
  private software = false;
  private decoderPreference: MirrorStatistics["decoder"] = "unspecified";
  private submitted = new Map<number, number>();
  private requestAt = -Infinity;
  private requestPending = false;
  private revision = 0;
  private shape = "";
  private reconnects = 0;
  private dropped = 0;
  private received = 0;
  private decoded = 0;
  private presented = 0;
  private drawTime = 0;
  private sampleStarted = performance.now();
  private latencies: number[] = [];
  private state = "";
  private running = false;
  private sampleTimer?: ReturnType<typeof setInterval>;
  private readonly context: OffscreenCanvasRenderingContext2D;

  constructor(private readonly canvas: OffscreenCanvas, private readonly serial: string, private readonly generation: number,
    private readonly emit: (event: MirrorWorkerEvent) => void,
    private readonly observePresentation?: (context: OffscreenCanvasRenderingContext2D, width: number, height: number, frame: VideoFrame) => void) {
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context) throw new Error("Offscreen video rendering is unavailable");
    this.context = context;
  }

  start(): void {
    if (this.running || this.lifetime.signal.aborted) return;
    this.running = true;
    this.sampleTimer = setInterval(() => this.statistics(), 1000);
    void this.connect().catch(error => { if (!this.lifetime.signal.aborted) this.status("error", String(error)); });
  }

  stop(): void {
    this.lifetime.abort(); clearInterval(this.sampleTimer); this.abortAttempt(); this.releaseDecoder(); this.running = false;
  }

  reconnect(): void { this.abortAttempt(new Error("Reconnecting video")); }

  private status(state: "connecting" | "live" | "recovering" | "error", error?: string, requestError?: unknown): void {
    const key = `${state}:${error ?? ""}`;
    if (this.state === key || this.lifetime.signal.aborted) return;
    this.state = key; this.emit({ type: "state", state, ...(error ? { error } : {}), ...(requestError ? { requestError } : {}) });
  }

  private current(attempt: Attempt): boolean { return this.attempt === attempt && !attempt.abort.signal.aborted && !this.lifetime.signal.aborted; }

  private abortAttempt(error?: Error): void {
    const attempt = this.attempt; if (!attempt) return;
    attempt.failure = error; clearTimeout(attempt.watchdog); attempt.abort.abort();
    void attempt.reader?.cancel(error).catch(() => undefined);
  }

  private watch(attempt: Attempt, ms = 8000): void {
    clearTimeout(attempt.watchdog);
    attempt.watchdog = setTimeout(() => {
      if (!this.current(attempt)) return;
      if (attempt.submitted && !attempt.decoded) this.software = true;
      this.abortAttempt(new Error(`The device stopped producing decoded video (${attempt.submitted} submitted, ${attempt.decoded} decoded)`));
    }, ms);
  }

  private async connect(): Promise<void> {
    let failures = 0;
    while (!this.lifetime.signal.aborted) {
      const attempt: Attempt = { id: ++this.nextAttempt, abort: new AbortController(), submitted: 0, decoded: 0 };
      this.attempt = attempt;
      this.status(this.revision ? "recovering" : "connecting");
      this.watch(attempt, 30000);
      try {
        const response = await fetch(`/api/harmony/video?serial=${encodeURIComponent(this.serial)}`, {
          cache: "no-store", credentials: "same-origin", signal: attempt.abort.signal,
          headers: { Accept: "application/vnd.piora.harmony-stream" },
        });
        if (!this.current(attempt)) { await response.body?.cancel(); throw new Error("Video connection was cancelled"); }
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          throw new VideoRequestError(value.error, response.status);
        }
        if (Number(response.headers.get("X-Harmony-Generation")) !== this.generation) {
          await response.body?.cancel(); throw new Error("Video belongs to an expired device connection");
        }
        if (!response.body) throw new Error("Video response has no body");
        this.watch(attempt);
        const reader = response.body.getReader(); attempt.reader = reader;
        const packets = new VideoPacketReader();
        while (this.current(attempt)) {
          const next = await reader.read();
          if (next.done) { packets.finish(); throw attempt.failure ?? new Error("Video connection closed"); }
          let batch = 0;
          for (const packet of packets.push(next.value)) {
            if (!this.current(attempt)) break;
            if (packet.type === VIDEO_CONFIG) await this.configure(parseVideoConfiguration(packet.payload), attempt);
            else if (packet.type === VIDEO_FRAME) {
              this.frame(packet.payload, attempt);
              // HTTP implementations may coalesce many packets into one read.
              // Give the codec a turn before interpreting that burst as backlog.
              if (++batch % 6 === 0 && (this.decoder?.decodeQueueSize ?? 0) > 2) await pause(0, attempt.abort.signal);
            }
          }
          if (attempt.decoded >= 60) failures = 0;
        }
        if (!this.lifetime.signal.aborted) throw attempt.failure ?? new Error("Video connection interrupted");
      } catch (error) {
        if (this.lifetime.signal.aborted) break;
        if (error instanceof VideoRequestError && error.controlStatus === "recovering") {
          // Reconnecting transport cannot confirm that physical input was released.
          // Stop the retry loop and let the user follow the recovery instructions.
          this.status("error", error.message, error.value);
          return;
        }
        this.reconnects++; failures++;
        this.status("recovering", attempt.failure?.message ?? (error instanceof Error ? error.message : String(error)), error instanceof VideoRequestError ? error.value : undefined);
      } finally {
        clearTimeout(attempt.watchdog); attempt.abort.abort();
        await attempt.reader?.cancel().catch(() => undefined); attempt.reader?.releaseLock();
        this.releaseDecoder(); this.config = undefined;
        if (this.attempt === attempt) this.attempt = undefined;
      }
      await pause(Math.min(2000, 150 * 2 ** Math.min(failures - 1, 4)), this.lifetime.signal);
    }
  }

  private releaseDecoder(): void {
    this.decoderEpoch++;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined; this.decoderConfig = undefined; this.submitted.clear(); this.needsKey = true;
  }

  private async configure(config: VideoConfiguration, attempt: Attempt): Promise<void> {
    this.releaseDecoder(); this.config = config;
    const epoch = this.decoderEpoch;
    if (config.codec !== 0) throw new Error("The new mirror requires native H.264 video");
    if (typeof VideoDecoder === "undefined") throw new Error("This runtime does not support WebCodecs");
    const preferences: HardwareAcceleration[] = this.software ? ["prefer-software", "no-preference"] : ["prefer-hardware", "no-preference", "prefer-software"];
    let supported: VideoDecoderConfig | undefined;
    for (const hardwareAcceleration of preferences) {
      const candidate: VideoDecoderConfig = { codec: avcCodec(config.sps), codedWidth: config.width, codedHeight: config.height, optimizeForLatency: true, hardwareAcceleration };
      const result = await VideoDecoder.isConfigSupported(candidate).catch(() => undefined);
      if (!this.current(attempt) || this.decoderEpoch !== epoch) return;
      if (result?.supported) { supported = result.config ?? candidate; break; }
    }
    if (!supported) throw new Error("No compatible H.264 decoder is available");
    this.decoderConfig = supported;
    this.decoderPreference = supported.hardwareAcceleration === "prefer-hardware" ? "hardware-preferred"
      : supported.hardwareAcceleration === "prefer-software" ? "software-preferred" : "unspecified";
    this.decoder = new VideoDecoder({
      output: frame => {
        if (!this.current(attempt) || epoch !== this.decoderEpoch) { frame.close(); return; }
        const receivedAt = this.submitted.get(frame.timestamp);
        this.submitted.delete(frame.timestamp);
        // A reset invalidates every queued output even when a codec delivers it late.
        if (receivedAt === undefined) { frame.close(); return; }
        attempt.decoded++; this.decoded++; this.watch(attempt);
        // Live frames already arrive at capture cadence. A second RAF queue
        // merges distinct new frames with encoder repeats and adds a vsync of
        // latency. Submit immediately; Chromium owns canvas compositing.
        try { this.present(frame, receivedAt, epoch); }
        catch (error) { this.abortAttempt(error instanceof Error ? error : new Error(String(error))); }
      },
      error: error => {
        if (!this.current(attempt) || epoch !== this.decoderEpoch) return;
        this.software = true; this.abortAttempt(new Error(`Video decode failed: ${error.message}`));
      },
    });
    this.decoder.configure(supported);
  }

  private frame(payload: Uint8Array, attempt: Attempt): void {
    if (!this.config || payload.length < 10) throw new Error("Truncated video frame");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const key = Boolean(payload[0] & 1), timestamp = Number(view.getBigUint64(1));
    if (!Number.isSafeInteger(timestamp)) throw new Error("Invalid video timestamp");
    if (!this.received && !this.decoded && !this.presented && !this.revision) this.sampleStarted = performance.now();
    this.received++;
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    const oldest = this.submitted.values().next().value as number | undefined;
    // A network chunk may contain several healthy frames. A four-frame cap
    // resets the GOP before the decoder gets a turn even with < 40 ms backlog.
    // Bound elapsed age first; retain a hard capacity for malformed/burst input.
    if (decoder.decodeQueueSize > 12 || this.submitted.size > 12 || oldest !== undefined && performance.now() - oldest > 80) {
      this.dropped += this.submitted.size; this.submitted.clear();
      decoder.reset(); decoder.configure(this.decoderConfig!); this.needsKey = true;
      this.requestKeyframe(attempt);
    }
    if (this.needsKey && !key) { this.dropped++; this.requestKeyframe(attempt); return; }
    const data = payload.subarray(9);
    this.submitted.set(timestamp, performance.now());
    attempt.submitted++;
    decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: key ? avcKeyframe(this.config, data) : annexB(data) }));
    this.needsKey = false;
  }

  private requestKeyframe(attempt: Attempt): void {
    const now = performance.now();
    if (this.requestPending || now - this.requestAt < 250 || !this.current(attempt)) return;
    this.requestAt = now; this.requestPending = true;
    void fetch(`/api/harmony/video?serial=${encodeURIComponent(this.serial)}&generation=${this.generation}`, {
      method: "POST", credentials: "same-origin", signal: attempt.abort.signal,
    }).catch(() => undefined).finally(() => { this.requestPending = false; });
  }

  private present(frame: VideoFrame, receivedAt: number, epoch: number): void {
    try {
      if (epoch !== this.decoderEpoch || this.lifetime.signal.aborted) return;
      const width = frame.displayWidth, height = frame.displayHeight;
      if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
      const start = performance.now(); this.context.drawImage(frame, 0, 0, width, height);
      this.drawTime += performance.now() - start;
      this.observePresentation?.(this.context, width, height, frame);
      this.presented++; this.revision++;
      this.latencies.push(performance.now() - receivedAt);
      const shape = `${width}:${height}`;
      if (shape !== this.shape || this.state !== "live:") {
        this.shape = shape; this.emit({ type: "frame", width, height, revision: this.revision });
      }
      this.status("live"); this.statistics();
    } finally { frame.close(); }
  }

  private statistics(): void {
    const now = performance.now(), elapsed = now - this.sampleStarted;
    if (elapsed < 1000) return;
    this.latencies.sort((a, b) => a - b);
    const statistics: MirrorStatistics = {
      receivedFps: this.received * 1000 / elapsed, decodedFps: this.decoded * 1000 / elapsed,
      presentedFps: this.presented * 1000 / elapsed, receiveToDrawP95Ms: this.latencies[Math.floor(this.latencies.length * .95)] ?? 0,
      drawMs: this.drawTime / Math.max(1, this.presented), droppedFrames: this.dropped,
      decoderQueue: this.decoder?.decodeQueueSize ?? 0, reconnects: this.reconnects,
      decoder: this.decoderPreference,
    };
    this.emit({ type: "statistics", statistics });
    this.sampleStarted = now; this.received = 0; this.decoded = 0; this.presented = 0; this.drawTime = 0; this.latencies = [];
  }
}
