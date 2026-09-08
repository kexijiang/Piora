"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

export type HarmonyFrameStatus = "idle" | "loading" | "live" | "error";
export type HarmonyFrameMode = "idle" | "video" | "frames";

export interface HarmonyLiveFrame {
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
  serial: string;
  generation?: number;
  fallbackError: string;
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
  controller: AbortController;
  watchdog?: number;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  failure?: Error;
  startedAt: number;
  decodedFrames: number;
  jpegChain: Promise<void>;
};

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
  return typeof payload.error === "string" ? payload.error : payload.error?.message || `Request failed (${response.status})`;
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

function reconnectDelay(failures: number): number {
  return Math.min(8_000, 250 * (2 ** Math.min(Math.max(0, failures - 1), 5)));
}

export function useHarmonyLiveFrame(options: UseHarmonyLiveFrameOptions) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<HarmonyFrameStatus>("idle");
  const [mode, setMode] = useState<HarmonyFrameMode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<HarmonyLiveFrame | null>(null);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (!options.active || !options.enabled || !options.serial || options.generation === undefined) {
      setFrame(null);
      setStatus("idle");
      setMode("idle");
      setError(null);
      return;
    }
    if (options.paused) return;

    const lifecycle = new AbortController();
    let disposed = false;
    let decoder: VideoDecoder | undefined;
    let config: StreamConfig | undefined;
    let revision = 0;
    let firstKeyframe = false;
    let failures = 0;
    let hasFrame = false;
    let activeAttempt: StreamAttempt | undefined;
    const closeDecoder = () => {
      // WebCodecs closes itself after a fatal decode error.
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined;
    };
    const armWatchdog = (attempt: StreamAttempt) => {
      window.clearTimeout(attempt.watchdog);
      attempt.watchdog = window.setTimeout(() => {
        if (disposed || activeAttempt !== attempt) return;
        attempt.failure = new Error("Harmony video stopped producing frames");
        attempt.controller.abort();
        void attempt.reader?.cancel(attempt.failure).catch(() => undefined);
      }, 15_000);
    };
    setFrame(null);
    setStatus("loading");
    setMode("video");
    setError(null);
    const initialCanvas = options.canvasRef.current;
    initialCanvas?.getContext("2d")?.clearRect(0, 0, initialCanvas.width, initialCanvas.height);

    const publishFrame = (width: number, height: number, attempt: StreamAttempt) => {
      if (disposed) return;
      revision += 1;
      attempt.decodedFrames += 1;
      armWatchdog(attempt);
      if (attempt.decodedFrames >= STABLE_STREAM_FRAMES || performance.now() - attempt.startedAt >= STABLE_STREAM_MS) {
        failures = 0;
      }
      const nextFrame = { serial: options.serial, generation: options.generation!, revision, width, height };
      if (!hasFrame) {
        hasFrame = true;
        setFrame(nextFrame);
      } else {
        setFrame((current) => current && current.width === width && current.height === height ? current : nextFrame);
      }
      setStatus("live");
      setError(null);
    };

    const drawVideoFrame = (videoFrame: VideoFrame, attempt: StreamAttempt) => {
      try {
        const canvas = options.canvasRef.current;
        if (!canvas || disposed || activeAttempt !== attempt) return;
        const width = videoFrame.displayWidth || videoFrame.codedWidth;
        const height = videoFrame.displayHeight || videoFrame.codedHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        canvas.getContext("2d", { alpha: false })?.drawImage(videoFrame, 0, 0, width, height);
        publishFrame(width, height, attempt);
      } finally {
        videoFrame.close();
      }
    };

    const configureDecoder = async (next: StreamConfig, attempt: StreamAttempt) => {
      closeDecoder();
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
      if (disposed || activeAttempt !== attempt) return;
      if (!support.supported) throw new Error(`H.264 decoder ${decoderConfig.codec} is unavailable`);
      decoder = new VideoDecoder({
        output: (videoFrame) => drawVideoFrame(videoFrame, attempt),
        error: (decodeError) => {
          if (disposed || activeAttempt !== attempt) return;
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
        if (!canvas || disposed || activeAttempt !== attempt) return;
        if (canvas.width !== next.width || canvas.height !== next.height) {
          canvas.width = next.width;
          canvas.height = next.height;
        }
        canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, next.width, next.height);
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
      if (!canvas || disposed || activeAttempt !== attempt) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const pixels = new Uint8ClampedArray(bytes.slice(8).buffer as ArrayBuffer);
      canvas.getContext("2d", { alpha: false })?.putImageData(new ImageData(pixels, width, height), 0, 0);
      publishFrame(width, height, attempt);
    };

    const processPacket = async (type: number, payload: Uint8Array, attempt: StreamAttempt) => {
      if (type === VIDEO_CONFIG) {
        config = parseConfig(payload);
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
        if (decoder.decodeQueueSize > 8 && !keyframe) {
          // Dropping one dependent H.264 delta frame corrupts the reference chain.
          // Drop the rest of the GOP and recover cleanly from the next keyframe.
          firstKeyframe = false;
          return;
        }
        const chunkData = keyframe ? keyframeData(config, data) : startCodedUnit(data);
        decoder.decode(new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp, data: chunkData }));
        if (keyframe) firstKeyframe = true;
      } else if (config.codec === JPEG) {
        attempt.jpegChain = attempt.jpegChain.then(() => drawJpeg(data, config!, attempt));
        await attempt.jpegChain;
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

    const pollFrames = async () => {
      let fallbackFailures = 0;
      setMode("frames");
      closeDecoder();
      config = undefined;
      firstKeyframe = false;
      while (!lifecycle.signal.aborted) {
        if (document.hidden) {
          await delay(1_000, lifecycle.signal);
          continue;
        }
        try {
          const response = await fetch(`/api/harmony/frame?serial=${encodeURIComponent(options.serial)}&v=${Date.now()}`, {
            cache: "no-store",
            signal: lifecycle.signal,
          });
          if (!response.ok) throw new Error(await responseError(response));
          const generation = Number(response.headers.get("X-Harmony-Generation"));
          const frameRevision = Number(response.headers.get("X-Harmony-Revision"));
          if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(frameRevision)) {
            throw new Error("Device frame metadata is invalid");
          }
          const bitmap = await createImageBitmap(await response.blob());
          try {
            const canvas = options.canvasRef.current;
            if (!canvas || disposed) return;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
            hasFrame = true;
            setFrame({
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
          await delay(120, lifecycle.signal);
        } catch (frameError) {
          if (lifecycle.signal.aborted || disposed) return;
          fallbackFailures += 1;
          // Agent device actions intentionally interrupt an in-flight passive
          // screenshot. Keep the last frame visible and retry instead of
          // presenting the device as unavailable while the Agent is working.
          if (!hasFrame) {
            setStatus("error");
            setError(frameError instanceof Error ? frameError.message : options.fallbackError);
          } else {
            setStatus("live");
            setError(null);
          }
          await delay(Math.min(4_000, 250 * (2 ** Math.min(fallbackFailures - 1, 4))), lifecycle.signal);
        }
      }
    };

    const connect = async () => {
      while (!lifecycle.signal.aborted) {
        const attempt: StreamAttempt = {
          controller: new AbortController(),
          startedAt: performance.now(),
          decodedFrames: 0,
          jpegChain: Promise.resolve(),
        };
        activeAttempt = attempt;
        const abortAttempt = () => attempt.controller.abort();
        lifecycle.signal.addEventListener("abort", abortAttempt, { once: true });
        armWatchdog(attempt);
        if (!hasFrame) setStatus("loading");
        try {
          const response = await fetch(`/api/harmony/video?serial=${encodeURIComponent(options.serial)}`, {
            cache: "no-store",
            headers: { Accept: "application/vnd.piora.harmony-stream" },
            signal: attempt.controller.signal,
          });
          if (!response.ok) throw new Error(await responseError(response));
          if (!response.body) throw new Error("Harmony video response has no stream body");
          await consume(response.body, attempt);
        } catch (streamError) {
          window.clearTimeout(attempt.watchdog);
          attempt.controller.abort();
          if (lifecycle.signal.aborted || disposed) return;
          failures += 1;
          if (!hasFrame || failures > 1) {
            setStatus("error");
            setError(attempt.failure?.message ?? (streamError instanceof Error ? streamError.message : options.fallbackError));
          } else {
            setStatus("live");
            setError(null);
          }
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
            await pollFrames();
            return;
          }
          await attempt.jpegChain.catch(() => undefined);
          await delay(reconnectDelay(failures), lifecycle.signal);
        } finally {
          window.clearTimeout(attempt.watchdog);
          lifecycle.signal.removeEventListener("abort", abortAttempt);
          if (activeAttempt === attempt) activeAttempt = undefined;
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      lifecycle.abort();
      window.clearTimeout(activeAttempt?.watchdog);
      closeDecoder();
      void activeAttempt?.reader?.cancel().catch(() => undefined);
      void activeAttempt?.jpegChain.catch(() => undefined);
    };
  }, [options.active, options.canvasRef, options.enabled, options.fallbackError, options.generation, options.paused, options.serial, refreshKey]);

  return { frame, status, mode, error, refresh };
}
