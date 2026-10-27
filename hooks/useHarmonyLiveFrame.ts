"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { HarmonyRequestError } from "@/lib/harmony/request-error";

export type HarmonyFrameStatus = "idle" | "loading" | "live" | "error";
export type HarmonyFrameMode = "idle" | "video" | "frames";

export interface HarmonyLiveFrame {
  geometryId?: string;
  serial: string;
  generation: number;
  revision: number;
  width: number;
  height: number;
}

interface UseHarmonyLiveFrameOptions {
  active: boolean;
  enabled: boolean;
  paused?: boolean;
  preferFrames?: boolean;
  /** Passive viewers do not need the HDC input-coordinate calibration loop. */
  calibrateGeometry?: boolean;
  serial: string;
  generation?: number;
  fallbackError: string;
  chinese?: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

const PACKET_HEADER_BYTES = 8;
const MAX_PACKET_BYTES = 64 * 1024 * 1024;
const VIDEO_CONFIG = 0x02;
const VIDEO_FRAME = 0x03;
const H264 = 0;
const RAW_RGBA = 1;
const JPEG = 2;
const STABLE_STREAM_FRAMES = 30;
const STABLE_STREAM_MS = 5_000;

type StreamConfig = {
  codec: number;
  width: number;
  height: number;
  fps: number;
  sps: Uint8Array;
  pps: Uint8Array;
};

type StreamAttempt = {
  geometryTimer?: number;
  geometryConfig?: StreamConfig;
  geometryRefreshing?: boolean;
  geometryId?: string;
  controller: AbortController;
  watchdog?: number;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  failure?: Error;
  startedAt: number;
  decodedFrames: number;
  jpegChain: Promise<void>;
  jpegPending?: { bytes: Uint8Array; config: StreamConfig };
  jpegBusy?: boolean;
};

async function responseError(response: Response, chinese: boolean): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  return new HarmonyRequestError(payload.error, response.status).messageFor(chinese);
}

function startCodedUnit(unit: Uint8Array): Uint8Array {
  if ((unit[0] === 0 && unit[1] === 0 && unit[2] === 1)
    || (unit[0] === 0 && unit[1] === 0 && unit[2] === 0 && unit[3] === 1)) return unit;
  const result = new Uint8Array(unit.length + 4);
  result.set([0, 0, 0, 1]);
  result.set(unit, 4);
  return result;
}

function h264Codec(sps: Uint8Array): string {
  const unit = startCodedUnit(sps);
  const offset = unit[2] === 1 ? 3 : 4;
  const profile = unit[offset + 1] ?? 0x42;
  const compatibility = unit[offset + 2] ?? 0xe0;
  const level = unit[offset + 3] ?? 0x1f;
  return `avc1.${[profile, compatibility, level].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function keyframeData(config: StreamConfig, frame: Uint8Array): Uint8Array {
  const sps = startCodedUnit(config.sps);
  const pps = startCodedUnit(config.pps);
  const nal = startCodedUnit(frame);
  const result = new Uint8Array(sps.length + pps.length + nal.length);
  result.set(sps, 0);
  result.set(pps, sps.length);
  result.set(nal, sps.length + pps.length);
  return result;
}

function parseConfig(payload: Uint8Array): StreamConfig {
  if (payload.length < 13) throw new Error("Harmony video configuration is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const config: StreamConfig = {
    codec: view.getUint8(0),
    width: view.getUint32(1, false),
    height: view.getUint32(5, false),
    fps: view.getUint32(9, false),
    sps: new Uint8Array(),
    pps: new Uint8Array(),
  };
  if (config.width < 1 || config.height < 1 || config.width > 16_384 || config.height > 16_384) {
    throw new Error("Harmony video dimensions are invalid");
  }
  if (config.codec !== H264) return config;
  if (payload.length < 17) throw new Error("Harmony H.264 configuration is truncated");
  let offset = 13;
  const spsLength = view.getUint16(offset, false);
  offset += 2;
  if (offset + spsLength + 2 > payload.length) throw new Error("Harmony H.264 SPS is truncated");
  config.sps = payload.slice(offset, offset + spsLength);
  offset += spsLength;
  const ppsLength = view.getUint16(offset, false);
  offset += 2;
  if (offset + ppsLength > payload.length) throw new Error("Harmony H.264 PPS is truncated");
  config.pps = payload.slice(offset, offset + ppsLength);
  return config;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = window.setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForDecoderCapacity(decoder: VideoDecoder, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || decoder.state !== "configured") return false;
  if (decoder.decodeQueueSize <= 8) return true;
  return new Promise((resolveCapacity) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      decoder.removeEventListener("dequeue", check);
      signal.removeEventListener("abort", abort);
      resolveCapacity(available);
    };
    const check = () => {
      if (signal.aborted || decoder.state !== "configured") finish(false);
      else if (decoder.decodeQueueSize <= 4) finish(true);
    };
    const abort = () => finish(false);
    // Apply bounded backpressure before abandoning a dependent frame group.
    // Most short decoder bursts drain without waiting for another keyframe.
    const timer = window.setTimeout(() => finish(!signal.aborted && decoder.state === "configured" && decoder.decodeQueueSize <= 8), 1_000);
    decoder.addEventListener("dequeue", check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

function reconnectDelay(failures: number): number {
  // Stay inside the phone's five-second consented-session reconnect grace.
  return Math.min(2_000, 250 * (2 ** Math.min(Math.max(0, failures - 1), 3)));
}

export function useHarmonyLiveFrame(options: UseHarmonyLiveFrameOptions) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<HarmonyFrameStatus>("idle");
  const [mode, setMode] = useState<HarmonyFrameMode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<HarmonyLiveFrame | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<{ fps: number; drawMs: number } | null>(null);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    setMetrics(null);
    if (!options.active || !options.enabled || !options.serial || options.generation === undefined) {
      setFrame(null);
      setStatus("idle");
      setMode("idle");
      setError(null);
      setFallbackReason(null);
      return;
    }
    if (options.paused) return;

    const lifecycle = new AbortController();
    let disposed = false;
    let decoder: VideoDecoder | undefined;
    let pendingPresentation: { frame: VideoFrame; attempt: StreamAttempt } | undefined;
    let presentationTick: number | undefined;
    let decoderEpoch = 0;
    let config: StreamConfig | undefined;
    let revision = 0;
    let firstKeyframe = false;
    let failures = 0;
    let hasFrame = false;
    let activeAttempt: StreamAttempt | undefined;
    let fallback: { controller: AbortController; done: Promise<void> } | undefined;
    const fallbackActive = () => Boolean(fallback && !fallback.controller.signal.aborted);
    let measuredFrames = 0, drawMilliseconds = 0, measuredAt = performance.now();
    const measuredDraw = (draw: () => void) => {
      const start = performance.now(); draw(); measuredFrames++; drawMilliseconds += performance.now() - start;
      const now = performance.now();
      if (now - measuredAt < 1000) return;
      setMetrics({ fps: Math.round(measuredFrames * 10000 / Math.max(1, now - measuredAt)) / 10,
        drawMs: Math.round(drawMilliseconds / measuredFrames * 10) / 10 });
      measuredAt = now; measuredFrames = 0; drawMilliseconds = 0;
    };
    const closeDecoder = () => {
      if (presentationTick !== undefined) window.cancelAnimationFrame?.(presentationTick);
      presentationTick = undefined;
      pendingPresentation?.frame.close();
      pendingPresentation = undefined;
      // A stream can change configuration without replacing its connection.
      // Invalidate callbacks before close, which may itself deliver an error.
      decoderEpoch += 1;
      // WebCodecs closes itself after a fatal decode error.
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined;
    };
    const armWatchdog = (attempt: StreamAttempt, budgetMs = 15_000) => {
      window.clearTimeout(attempt.watchdog);
      attempt.watchdog = window.setTimeout(() => {
        if (disposed || activeAttempt !== attempt) return;
        attempt.failure = new Error("Harmony video stopped producing frames");
        attempt.controller.abort();
        void attempt.reader?.cancel(attempt.failure).catch(() => undefined);
      }, budgetMs);
    };
    setFrame(null);
    setStatus("loading");
    setMode("video");
    setError(null);
    setFallbackReason(null);
    const initialCanvas = options.canvasRef.current;
    initialCanvas?.getContext("2d")?.clearRect(0, 0, initialCanvas.width, initialCanvas.height);

    const refreshGeometry = async (attempt: StreamAttempt, expected: StreamConfig) => {
      const isCurrent = () => !disposed && !attempt.controller.signal.aborted && activeAttempt === attempt && attempt.geometryConfig === expected;
      if (!isCurrent() || attempt.geometryRefreshing) return;
      attempt.geometryRefreshing = true;
      let geometryId: string | undefined;
      try {
        const response = await fetch(`/api/harmony/geometry?serial=${encodeURIComponent(options.serial)}&space=video`, { cache: "no-store", signal: attempt.controller.signal });
        if (response.ok) {
          const { geometry } = await response.json();
          if (geometry?.frameWidth === expected.width && geometry?.frameHeight === expected.height && typeof geometry.geometryId === "string") geometryId = geometry.geometryId;
        }
      } catch { /* A later automatic probe can recover without reconnecting. */ }
      if (!isCurrent()) return;
      attempt.geometryId = geometryId;
      attempt.geometryRefreshing = false;
      // A static phone may not send another frame after the asynchronous probe.
      // Publish readiness (and failures) immediately, without waiting for pixels.
      setFrame(current => current && current.width === expected.width && current.height === expected.height
        && current.geometryId !== geometryId ? { ...current, geometryId } : current);
      attempt.geometryTimer = window.setTimeout(() => {
        attempt.geometryTimer = undefined;
        void refreshGeometry(attempt, expected);
      }, 1500);
    };

    const publishFrame = (width: number, height: number, attempt: StreamAttempt) => {
      if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
      // Only decoded pixels complete the handoff. Configuration alone cannot
      // replace the working fallback, and its outstanding bitmap is fenced.
      fallback?.controller.abort();
      setMode("video");
      if (options.calibrateGeometry !== false && attempt.geometryConfig && !attempt.geometryRefreshing && attempt.geometryTimer === undefined) void refreshGeometry(attempt, attempt.geometryConfig);
      revision += 1;
      attempt.decodedFrames += 1;
      armWatchdog(attempt);
      if (attempt.decodedFrames >= STABLE_STREAM_FRAMES || performance.now() - attempt.startedAt >= STABLE_STREAM_MS) {
        failures = 0;
      }
      const nextFrame = { serial: options.serial, generation: options.generation!, revision, width, height, geometryId: attempt.geometryId };
      if (!hasFrame) {
        hasFrame = true;
        setFrame(nextFrame);
      } else {
        setFrame((current) => current && current.width === width && current.height === height && current.geometryId === nextFrame.geometryId ? current : nextFrame);
      }
      setStatus("live");
      setError(null);
      setFallbackReason(null);
    };

    const drawVideoFrame = (videoFrame: VideoFrame, attempt: StreamAttempt) => {
      try {
        const canvas = options.canvasRef.current;
        if (!canvas || disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
        const width = videoFrame.displayWidth || videoFrame.codedWidth;
        const height = videoFrame.displayHeight || videoFrame.codedHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        measuredDraw(() => { canvas.getContext("2d", { alpha: false })?.drawImage(videoFrame, 0, 0, width, height); });
        publishFrame(width, height, attempt);
      } finally {
        videoFrame.close();
      }
    };

    const configureDecoder = async (next: StreamConfig, attempt: StreamAttempt) => {
      closeDecoder();
      const configuredEpoch = decoderEpoch;
      firstKeyframe = false;
      if (next.codec !== H264) return;
      if (!("VideoDecoder" in window)) throw new Error("This Piora runtime does not support hardware video decoding");
      const decoderConfig: VideoDecoderConfig = {
        codec: h264Codec(next.sps),
        codedWidth: next.width,
        codedHeight: next.height,
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware",
      };
      const support = await VideoDecoder.isConfigSupported(decoderConfig);
      if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoderEpoch !== configuredEpoch) return;
      if (!support.supported) throw new Error(`H.264 decoder ${decoderConfig.codec} is unavailable`);
      decoder = new VideoDecoder({
        output: (videoFrame) => {
          if (decoderEpoch !== configuredEpoch) {
            videoFrame.close();
            return;
          }
          // Decode every dependent H.264 frame, but present only the newest
          // decoded image per display refresh. Never queue obsolete paints.
          if (!window.requestAnimationFrame) { drawVideoFrame(videoFrame, attempt); return; }
          pendingPresentation?.frame.close();
          pendingPresentation = { frame: videoFrame, attempt };
          presentationTick ??= window.requestAnimationFrame(() => {
            presentationTick = undefined;
            const pending = pendingPresentation; pendingPresentation = undefined;
            if (pending) drawVideoFrame(pending.frame, pending.attempt);
          });
        },
        error: (decodeError) => {
          if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoderEpoch !== configuredEpoch) return;
          const failure = new Error(decodeError.message || options.fallbackError);
          attempt.failure = failure;
          void attempt.reader?.cancel(failure).catch(() => undefined);
        },
      });
      decoder.configure(support.config ?? decoderConfig);
    };

    const drawJpeg = async (bytes: Uint8Array, next: StreamConfig, attempt: StreamAttempt) => {
      const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" }));
      try {
        const canvas = options.canvasRef.current;
        if (!canvas || disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || attempt.geometryConfig !== next) return;
        if (canvas.width !== next.width || canvas.height !== next.height) {
          canvas.width = next.width;
          canvas.height = next.height;
        }
        measuredDraw(() => { canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, next.width, next.height); });
        publishFrame(next.width, next.height, attempt);
      } finally {
        bitmap.close();
      }
    };

    const drawRgba = (bytes: Uint8Array, next: StreamConfig, attempt: StreamAttempt) => {
      if (bytes.length < 8) throw new Error("Harmony RGBA frame is truncated");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(0, false);
      const height = view.getUint32(4, false);
      if (width !== next.width || height !== next.height || bytes.length !== 8 + width * height * 4) {
        throw new Error("Harmony RGBA frame dimensions are invalid");
      }
      const canvas = options.canvasRef.current;
      if (!canvas || disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const pixels = new Uint8ClampedArray(bytes.slice(8).buffer as ArrayBuffer);
      measuredDraw(() => { canvas.getContext("2d", { alpha: false })?.putImageData(new ImageData(pixels, width, height), 0, 0); });
      publishFrame(width, height, attempt);
    };

    const processPacket = async (type: number, payload: Uint8Array, attempt: StreamAttempt) => {
      if (type === VIDEO_CONFIG) {
        config = parseConfig(payload);
        window.clearTimeout(attempt.geometryTimer);
        attempt.geometryTimer = undefined;
        attempt.geometryConfig = config;
        attempt.geometryRefreshing = false;
        attempt.geometryId = undefined;
        if (!fallbackActive()) {
          setStatus("loading");
          setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
        }
        await configureDecoder(config, attempt);
        return;
      }
      if (type !== VIDEO_FRAME || !config || payload.length < 9) return;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const keyframe = (view.getUint8(0) & 1) !== 0;
      const timestamp = Number(view.getBigUint64(1, false));
      const data = payload.subarray(9);
      if (config.codec === H264) {
        if (!decoder || decoder.state !== "configured") return;
        if (!firstKeyframe && !keyframe) return;
        if (decoder.decodeQueueSize > 8) {
          const pendingDecoder = decoder;
          const available = await waitForDecoderCapacity(pendingDecoder, attempt.controller.signal);
          if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoder !== pendingDecoder || decoder.state !== "configured") return;
          if (!available) {
            // Waiting for another keyframe on this connection can deadlock when
            // the producer only has dependent deltas left. Reconnect so the
            // bundled stream opens a fresh capture and requests a new IDR.
            const failure = new Error("Harmony video decoder remained overloaded");
            attempt.failure = failure;
            attempt.controller.abort();
            throw failure;
          }
        }
        const chunkData = keyframe ? keyframeData(config, data) : startCodedUnit(data);
        decoder.decode(new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp, data: chunkData }));
        if (keyframe) firstKeyframe = true;
      } else if (config.codec === JPEG) {
        // JPEG frames are independent. Keep reading the transport while one
        // bitmap decodes and replace the single pending frame with the latest.
        attempt.jpegPending = { bytes: data, config };
        if (!attempt.jpegBusy) {
          attempt.jpegBusy = true;
          attempt.jpegChain = (async () => {
            try {
              while (attempt.jpegPending && !attempt.controller.signal.aborted) {
                const next = attempt.jpegPending; attempt.jpegPending = undefined;
                await drawJpeg(next.bytes, next.config, attempt);
              }
            } catch (error) {
              attempt.failure = error instanceof Error ? error : new Error(String(error));
              attempt.controller.abort();
              void attempt.reader?.cancel(attempt.failure).catch(() => undefined);
            } finally { attempt.jpegBusy = false; attempt.jpegPending = undefined; }
          })();
        }
      } else if (config.codec === RAW_RGBA) {
        drawRgba(data, config, attempt);
      } else {
        throw new Error(`Unsupported Harmony video codec ${config.codec}`);
      }
    };

    const consume = async (body: ReadableStream<Uint8Array>, attempt: StreamAttempt) => {
      const reader = body.getReader();
      attempt.reader = reader;
      let pending = new Uint8Array();
      try {
        while (!lifecycle.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) throw attempt.failure ?? new Error("Harmony video connection closed");
          if (!value?.length) continue;
          if (pending.length + value.length > MAX_PACKET_BYTES + PACKET_HEADER_BYTES) {
            throw new Error("Harmony video stream exceeded its buffer limit");
          }
          const combined = new Uint8Array(pending.length + value.length);
          combined.set(pending);
          combined.set(value, pending.length);
          pending = combined;
          let offset = 0;
          while (pending.length - offset >= PACKET_HEADER_BYTES) {
            const view = new DataView(pending.buffer, pending.byteOffset + offset, pending.length - offset);
            const type = view.getUint32(0, false);
            const length = view.getUint32(4, false);
            if (length > MAX_PACKET_BYTES) throw new Error("Harmony video packet is too large");
            if (pending.length - offset < PACKET_HEADER_BYTES + length) break;
            const payload = pending.slice(offset + PACKET_HEADER_BYTES, offset + PACKET_HEADER_BYTES + length);
            offset += PACKET_HEADER_BYTES + length;
            await processPacket(type, payload, attempt);
          }
          pending = offset === 0 ? pending : pending.slice(offset);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        if (attempt.reader === reader) attempt.reader = undefined;
        reader.releaseLock();
      }
    };

    const pollFrames = async (signal: AbortSignal) => {
      type FallbackGeometry = { width: number; height: number; geometryId: string };
      let fallbackGeometry: FallbackGeometry | undefined;
      let fallbackGeometryCheckedAt = 0;
      let geometryPending = false;
      let frameShape: { width: number; height: number; generation: number } | undefined;
      let geometryProbedShape: typeof frameShape;
      let fallbackFailures = 0;
      const refreshFallbackGeometry = (expected: NonNullable<typeof frameShape>) => {
        if (options.calibrateGeometry === false) return;
        if (geometryPending) return;
        geometryPending = true;
        geometryProbedShape = expected;
        fallbackGeometry = undefined;
        fallbackGeometryCheckedAt = performance.now();
        // Calibration can involve slow HDC commands. It gates input readiness,
        // not observation: never stall the next screenshot behind this request.
        void (async () => {
          let next: FallbackGeometry | undefined;
          try {
            const response = await fetch(`/api/harmony/geometry?serial=${encodeURIComponent(options.serial)}&space=screenshot`, { cache: "no-store", signal });
            if (response.ok) {
              const { geometry } = await response.json();
              if (geometry?.frameWidth === expected.width && geometry?.frameHeight === expected.height && typeof geometry.geometryId === "string") {
                next = { width: expected.width, height: expected.height, geometryId: geometry.geometryId };
              }
            }
          } catch { /* Keep observation available; retry calibration on later frames. */ }
          finally { geometryPending = false; }
          if (disposed || signal.aborted || frameShape !== expected) return;
          fallbackGeometry = next;
          setFrame(current => current && current.generation === expected.generation
            && current.width === expected.width && current.height === expected.height
            ? { ...current, geometryId: next?.geometryId } : current);
        })();
      };
      setMode("frames");
      while (!signal.aborted) {
        if (document.hidden) {
          await delay(1_000, signal);
          continue;
        }
        const captureStartedAt = performance.now();
        try {
          const response = await fetch(`/api/harmony/frame?serial=${encodeURIComponent(options.serial)}&v=${Date.now()}`, {
            cache: "no-store",
            signal,
          });
          if (!response.ok) throw new Error(await responseError(response, Boolean(options.chinese)));
          const generation = Number(response.headers.get("X-Harmony-Generation"));
          const frameRevision = Number(response.headers.get("X-Harmony-Revision"));
          if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(frameRevision)) {
            throw new Error("Device frame metadata is invalid");
          }
          if (generation !== options.generation) throw new Error("Device frame belongs to an old generation");
          const bitmap = await createImageBitmap(await response.blob());
          try {
            const canvas = options.canvasRef.current;
            if (!canvas || disposed || signal.aborted) return;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            measuredDraw(() => { canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height); });
            hasFrame = true;
            if (frameShape?.width !== bitmap.width || frameShape?.height !== bitmap.height || frameShape?.generation !== generation) {
              frameShape = { width: bitmap.width, height: bitmap.height, generation };
              fallbackGeometry = undefined;
            }
            if (geometryProbedShape !== frameShape || performance.now() - fallbackGeometryCheckedAt > 1500) {
              refreshFallbackGeometry(frameShape);
            }
            if (disposed || signal.aborted) return;
            setFrame({
              geometryId: fallbackGeometry?.geometryId,
              serial: options.serial,
              generation,
              revision: frameRevision,
              width: bitmap.width,
              height: bitmap.height,
            });
            setStatus("live");
            setError(null);
            fallbackFailures = 0;
          } finally {
            bitmap.close();
          }
          // Bound fast captures to ~8 fps without adding 120ms to an already
          // slow capture. There remains exactly one screenshot request at a time.
          await delay(Math.max(0, 120 - (performance.now() - captureStartedAt)), signal);
        } catch (frameError) {
          if (signal.aborted || disposed) return;
          fallbackFailures += 1;
          // Agent device actions intentionally interrupt an in-flight passive
          // screenshot. Keep the last frame visible and retry instead of
          // presenting the device as unavailable while the Agent is working.
          if (!hasFrame) {
            setStatus("error");
            setError(frameError instanceof Error ? frameError.message : options.fallbackError);
          } else {
            setStatus("error");
            setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
            fallbackGeometry = undefined;
            frameShape = undefined;
            setError(frameError instanceof Error ? frameError.message : options.fallbackError);
          }
          await delay(Math.min(4_000, 250 * (2 ** Math.min(fallbackFailures - 1, 4))), signal);
        }
      }
    };

    const startFallback = async () => {
      if (fallbackActive()) return;
      // A cancelled pump must settle before a replacement starts; there is
      // always at most one screenshot request and one bounded video probe.
      await fallback?.done;
      if (disposed || lifecycle.signal.aborted) return;
      const controller = new AbortController();
      fallback = { controller, done: pollFrames(controller.signal) };
    };

    const connect = async () => {
      if (options.preferFrames) { await pollFrames(lifecycle.signal); return; }
      while (!lifecycle.signal.aborted) {
        const attempt: StreamAttempt = {
          controller: new AbortController(),
          startedAt: performance.now(),
          decodedFrames: 0,
          jpegChain: Promise.resolve(),
        };
        activeAttempt = attempt;
        if (!fallbackActive()) setMode("video");
        const abortAttempt = () => attempt.controller.abort();
        lifecycle.signal.addEventListener("abort", abortAttempt, { once: true });
        // The optional SDK has a 20s startup budget, followed by the server's
        // bounded first-packet probe. Do not abort it before either can report.
        armWatchdog(attempt, 30_000);
        if (!hasFrame) setStatus("loading");
        try {
          const response = await fetch(`/api/harmony/video?serial=${encodeURIComponent(options.serial)}`, {
            cache: "no-store",
            headers: { Accept: "application/vnd.piora.harmony-stream" },
            signal: attempt.controller.signal,
          });
          if (disposed || lifecycle.signal.aborted || activeAttempt !== attempt || attempt.controller.signal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            throw attempt.failure ?? new Error("Harmony video connection was cancelled");
          }
          if (!response.ok) throw new Error(await responseError(response, Boolean(options.chinese)));
          if (!response.body) throw new Error("Harmony video response has no stream body");
          const responseGeneration = response.headers?.get("X-Harmony-Generation");
          if (responseGeneration != null && Number(responseGeneration) !== options.generation) throw new Error("Video belongs to an old device generation");
          // Establishing the connection and decoding its first frame each have
          // a bounded budget. Configuration packets cannot renew the latter;
          // only an actual displayed frame renews it after this transition.
          armWatchdog(attempt);
          await consume(response.body, attempt);
        } catch (streamError) {
          window.clearTimeout(attempt.watchdog);
          window.clearTimeout(attempt.geometryTimer);
          attempt.controller.abort();
          if (lifecycle.signal.aborted || disposed) return;
          failures += 1;
          if (!fallbackActive()) {
            setStatus("error");
            setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
          }
          const reason = attempt.failure?.message ?? (streamError instanceof Error ? streamError.message : options.fallbackError);
          if (!fallbackActive()) setError(reason);
          setFallbackReason(reason);
          closeDecoder();
          config = undefined;
          firstKeyframe = false;
          if ((!hasFrame && failures >= 1) || failures >= 3) {
            // The packaged low-latency video service is not available on every
            // device/decoder combination. Fall back to the existing bounded
            // screenshot endpoint so observation remains available while the
            // Agent holds the exclusive write lease.
            await attempt.jpegChain.catch(() => undefined);
            if (activeAttempt === attempt) activeAttempt = undefined;
            await startFallback();
          }
          await attempt.jpegChain.catch(() => undefined);
          await delay(reconnectDelay(failures), lifecycle.signal);
        } finally {
          window.clearTimeout(attempt.watchdog);
          window.clearTimeout(attempt.geometryTimer);
          lifecycle.signal.removeEventListener("abort", abortAttempt);
          if (activeAttempt === attempt) activeAttempt = undefined;
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      lifecycle.abort();
      fallback?.controller.abort();
      window.clearTimeout(activeAttempt?.watchdog);
      window.clearTimeout(activeAttempt?.geometryTimer);
      closeDecoder();
      void activeAttempt?.reader?.cancel().catch(() => undefined);
      void activeAttempt?.jpegChain.catch(() => undefined);
    };
  }, [options.active, options.canvasRef, options.chinese, options.enabled, options.fallbackError, options.generation, options.paused, options.preferFrames, options.calibrateGeometry, options.serial, refreshKey]);

  return { frame, status, mode, error, fallbackReason, refresh, metrics };
}
