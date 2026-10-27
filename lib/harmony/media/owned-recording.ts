import { open, copyFile, mkdtemp, rm, rmdir, stat, statfs, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedPacket } from "mediabunny";
import { asHarmonyError, HarmonyError } from "../errors";
import { RECORDING_POLICY, recordingLimitReason } from "./recording-policy";
import type { HarmonyRecordingContext, HarmonyVideoConnection } from "../types";

const MAX_BYTES = RECORDING_POLICY.maxBytes;
const MAX_PACKET = 16 * 1024 * 1024;
function units(data: Buffer): Buffer[] {
  const starts: Array<{ start: number; size: number }> = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] || data[i + 1]) continue;
    const size = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (size) { starts.push({ start: i, size }); i += size - 1; }
  }
  return starts.length ? starts.map((value, index) => data.subarray(value.start + value.size, starts[index + 1]?.start ?? data.length)).filter(value => value.length) : [data];
}
function lengthPrefixed(data: Buffer): Buffer {
  return Buffer.concat(units(data).map(unit => { const size = Buffer.alloc(4); size.writeUInt32BE(unit.length); return Buffer.concat([size, unit]); }));
}
function configuration(payload: Buffer) {
  // This stream path never toggles Huawei's system recorder; HdcBackend chooses that path
  // separately, before any mirror stream is opened (see media/system-recorder.ts).
  if (payload.length < 17 || payload[0] !== 0) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Owned MP4 recording requires the mirror's H.264 stream", { details: { dispatchState: "not-sent" } });
  const width = payload.readUInt32BE(1), height = payload.readUInt32BE(5), fps = payload.readUInt32BE(9);
  if (!width || !height || width > 8192 || height > 8192 || fps < 1 || fps > 120) throw new HarmonyError("INVALID_RESPONSE", "Invalid recording geometry or frame rate");
  const sl = payload.readUInt16BE(13), pp = 15 + sl;
  if (pp + 2 > payload.length) throw new HarmonyError("INVALID_RESPONSE", "Truncated recording SPS");
  const pl = payload.readUInt16BE(pp);
  if (pp + 2 + pl !== payload.length) throw new HarmonyError("INVALID_RESPONSE", "Truncated recording PPS");
  const sps = units(payload.subarray(15, pp))[0], pps = units(payload.subarray(pp + 2))[0];
  if (sps.length < 4 || pps.length < 1 || (sps[0] & 31) !== 7 || (pps[0] & 31) !== 8) throw new HarmonyError("INVALID_RESPONSE", "Invalid AVC parameter sets");
  const description = Buffer.alloc(11 + sps.length + pps.length);
  description.set([1, sps[1], sps[2], sps[3], 255, 225]); description.writeUInt16BE(sps.length, 6); description.set(sps, 8);
  description[8 + sps.length] = 1; description.writeUInt16BE(pps.length, 9 + sps.length); description.set(pps, 11 + sps.length);
  return { width, height, fps, description, codec: `avc1.${sps.subarray(1, 4).toString("hex")}` };
}

const STREAM_RESET_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "ECONNREFUSED"]);

/** True for a transport that the phone side closed or reset, e.g. `read ECONNRESET` through `hdc fport`. */
export function isRecordingStreamReset(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof value.code === "string" && STREAM_RESET_CODES.has(value.code)) return true;
    if (typeof value.message === "string" && /\b(?:ECONNRESET|EPIPE|ECONNABORTED|socket hang up)\b/.test(value.message)) return true;
    current = value.cause;
  }
  return false;
}

/**
 * `hdc fport` accepts the local connection even when nothing listens on the phone, then resets it
 * on the first read. A reset or EOF before the first video packet therefore means the phone's video
 * service is not running; report that instead of a raw `read ECONNRESET`.
 */
export function recordingStreamUnavailable(cause?: unknown): HarmonyError {
  return new HarmonyError("CAPABILITY_UNAVAILABLE", "The phone video service is not running. Open Piora screen sharing on the phone and tap Start sharing", {
    cause, details: { reason: "recording-stream-unavailable", dispatchState: "not-sent" },
  });
}

/** Records only this subscriber's encoded stream. No global recorder, process kill or device media deletion. */
export async function startOwnedRecording(connection: HarmonyVideoConnection, signal?: AbortSignal, onFailure?: (error: HarmonyError) => void, requireIsolation = false, context?: HarmonyRecordingContext) {
  const directory = context?.draftPath ? dirname(context.draftPath) : await mkdtemp(join(tmpdir(), "piora-owned-recording-"));
  await mkdir(directory, { recursive: true });
  const path = context?.draftPath ?? join(directory, "capture.mp4");
  const removeDirectory = async () => { if (!context?.draftPath) await rmdir(directory).catch(() => undefined); };
  let bytesWritten = 0, stopReason: string | undefined;
  const handle = await open(path, "wx", 0o600).catch(async error => { await removeDirectory(); await connection.close(); throw error; });
  const source = new EncodedVideoPacketSource("avc");
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(new WritableStream({
    async write(chunk) {
      bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.length);
      if (chunk.position + chunk.data.length > MAX_BYTES) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording reached its 2 GiB limit");
      let offset = 0;
      while (offset < chunk.data.length) { const result = await handle.write(chunk.data, offset, chunk.data.length - offset, chunk.position + offset); if (!result.bytesWritten) throw new Error("Recording write made no progress"); offset += result.bytesWritten; }
    },
  }), { chunked: true, chunkSize: 1024 * 1024 }) });
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { output.addVideoTrack(source); await output.start(); reader = connection.stream.getReader(); }
  catch (error) { await output.cancel().catch(() => undefined); await handle.close(); await rm(path, { force: true }); await removeDirectory(); await connection.close(); throw error; }
  let stopping = false, failure: unknown, frames = 0, firstTimestamp: number | undefined, config: ReturnType<typeof configuration> | undefined;
  let accepted = false, ended = false, failureReported = false;
  const reportFailure = () => {
    if (!accepted || !ended || stopping || !failure || failureReported || !onFailure) return;
    failureReported = true;
    const error = asHarmonyError(failure);
    // The reader's pump has settled. A failed forward close is still explicitly
    // uncertain, but no surviving media reader can be mistaken for phone input.
    queueMicrotask(() => {
      // The notification cannot revive the settled pump or bypass reader cleanup.
      try { onFailure(new HarmonyError(error.code, error.message, { details: { ...error.details, recordingStopped: true, recoverable: frames > 0, stopReason: stopReason ?? "interrupted" } })); }
      catch { /* Observer errors do not change the recording's retained failure. */ }
    });
  };
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let isolated = !requireIsolation;
  const isolationError = () => new HarmonyError("CAPABILITY_UNAVAILABLE", "The phone capture component has not confirmed recording-isolation protocol v1. Manually prepare a compatible Piora component before stream recording. Preview and screenshots remain available", { details: { reason: "recording-isolation-unavailable", requiredProtocolVersion: 1, dispatchState: "not-sent" } });
  const isolationTimer = requireIsolation ? setTimeout(() => { failure = isolationError(); rejectReady(failure); void close().catch(() => undefined); }, 1_000) : undefined;
  let closing: Promise<void> | undefined;
  // An already errored reader rejects cancel with its original stream error.
  // Await cancellation settlement; forward closure is the owned transport check.
  const close = () => closing ??= Promise.allSettled([reader.cancel().catch(() => undefined), connection.close()]).then(results => {
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) throw new HarmonyError("DEVICE_BUSY", "Recording stream cleanup is uncertain", {
      cause: rejected.reason, details: { cleanup: "uncertain", recordingStopped: true },
    });
  });
  const abort = () => { failure = new HarmonyError("COMMAND_ABORTED", "Recording startup was cancelled", { details: { dispatchState: "not-sent" } }); rejectReady(failure); void close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const startup = setTimeout(() => { failure = new HarmonyError("COMMAND_TIMEOUT", "No H.264 keyframe arrived for recording", { details: { dispatchState: "not-sent" } }); rejectReady(failure); void close().catch(() => undefined); }, 15000);
  let pending = Buffer.alloc(0), received = false;
  let diskPending = false;
  const diskTimer = setInterval(() => {
    if (diskPending || stopping || ended) return;
    diskPending = true;
    void (async () => {
      try {
        context?.onProgress?.({ bytesWritten });
        for (const directory of new Set([dirname(path), context?.destinationDirectory ?? dirname(path)])) {
          const space = await statfs(directory);
          if (space.bavail * space.bsize < RECORDING_POLICY.minimumFreeBytes) {
            stopReason = "disk-space"; failure = new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording stopped because disk space is low", { details: { recoverable: true, stopReason } });
            await close(); break;
          }
        }
      } catch (error) { failure ??= error; await close().catch(() => undefined); }
      finally { diskPending = false; }
    })();
  }, RECORDING_POLICY.diskCheckIntervalMs);
  diskTimer.unref?.();
  const pump = (async () => {
    try {
      while (!stopping && !failure) {
        const { done, value } = await reader.read();
        if (done) {
          if (!stopping && !received) throw recordingStreamUnavailable();
          if (!stopping) throw new HarmonyError("DEVICE_OFFLINE", "Recording stream ended before stop");
          break;
        }
        if (value.length) received = true;
        if (pending.length + value.length > MAX_PACKET + 8) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording packet buffer exceeded limit");
        pending = Buffer.concat([pending, value]);
        while (pending.length >= 8) {
          const type = pending.readUInt32BE(0), length = pending.readUInt32BE(4);
          if (length > MAX_PACKET) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording packet exceeded limit");
          if (pending.length < length + 8) break;
          const payload = pending.subarray(8, length + 8); pending = pending.subarray(length + 8);
          if (type === 0x21 && payload.length === 1 && payload[0] === 1) {
            isolated = true; clearTimeout(isolationTimer);
          } else if (type === 2) {
            const next = configuration(payload);
            if (config && (next.width !== config.width || next.height !== config.height || !next.description.equals(config.description))) { stopReason = "format-changed"; throw new HarmonyError("STALE_SNAPSHOT", "Video geometry or codec changed; the completed segment will be saved", { details: { recoverable: true, stopReason } }); }
            config = next;
          } else if (type === 3 && config && payload.length > 9) {
            if (!isolated) continue;
            const key = Boolean(payload[0] & 1), timestamp = Number(payload.readBigUInt64BE(1));
            if (!frames && !key) continue;
            if (!Number.isSafeInteger(timestamp)) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording timestamp limit exceeded");
            firstTimestamp ??= timestamp;
            const relative = (timestamp - firstTimestamp) / 1_000_000;
            if (relative < 0) throw new HarmonyError("INVALID_RESPONSE", "Recording timestamp moved backwards");
            const limit = recordingLimitReason(relative, bytesWritten + payload.length, frames);
            if (limit) {
              stopReason = limit;
              throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording limit reached; saving the completed segment", { details: { recoverable: true, stopReason } });
            }
            await source.add(new EncodedPacket(lengthPrefixed(payload.subarray(9)), key ? "key" : "delta", relative, 1 / config.fps), frames ? undefined : { decoderConfig: { codec: config.codec, codedWidth: config.width, codedHeight: config.height, description: config.description } });
            frames++; resolveReady();
          }
        }
      }
    } catch (error) {
      // Only a reset before the first packet means "service not running"; later resets keep their cause.
      failure ??= !received && !stopping && isRecordingStreamReset(error) ? recordingStreamUnavailable(error) : error;
      rejectReady(failure);
    }
    finally {
      await close().catch(error => {
        const original = failure ? asHarmonyError(failure) : asHarmonyError(error);
        failure = new HarmonyError(original.code, original.message, { cause: error,
          details: { ...original.details, cleanup: "uncertain", recordingStopped: true } });
      });
      clearInterval(diskTimer); ended = true; reportFailure();
    }
  })();
  if (signal?.aborted) abort();
  let discardPromise: Promise<void> | undefined;
  let completion: Promise<number> | undefined;
  let saveFailed = false;
  const discard = () => discardPromise ??= (async () => {
    if (completion) { await completion.catch(() => undefined); return; }
    if (saveFailed) return; // Failed saves retain recovery bytes until explicit recovery disposal.
    stopping = true;
    try { await close(); }
    finally { await pump; await output.cancel().catch(() => undefined); await handle.close(); await rm(path, { force: true }); await removeDirectory(); }
  })();
  try { await ready; }
  catch (error) { await discard(); throw error; }
  finally { clearTimeout(startup); clearTimeout(isolationTimer); signal?.removeEventListener("abort", abort); }
  accepted = true; reportFailure();
  let finalization: Promise<void> | undefined;
  const finalize = () => finalization ??= (async () => {
    stopping = true;
    await close(); await pump;
    if (!frames) throw failure ?? new HarmonyError("INVALID_RESPONSE", "No recording frames were received");
    source.close(); await output.finalize(); await handle.sync(); await handle.close();
    context?.onProgress?.({ bytesWritten, finalized: true, ...(stopReason ? { stopReason } : failure ? { stopReason: "interrupted" } : {}) });
  })();
  const stop = (destination: string): Promise<number> => {
    if (completion) return completion;
    completion = (async () => {
      try {
        await finalize();
        await copyFile(path, destination, constants.COPYFILE_EXCL);
        const size = (await stat(destination)).size;
        await rm(path, { force: true }); await removeDirectory();
        return size;
      } catch (cause) {
        saveFailed = true;
        await handle.close().catch(() => undefined);
        throw new HarmonyError("COMMAND_FAILED", "Recording could not be saved; the draft was retained for recovery", { cause, details: { ...asHarmonyError(cause).details, recordingStopped: true, recoverable: true, recoveryPath: path, finalized: output.state === "finalized", stopReason: stopReason ?? "save-failed" } });
      }
    })();
    void completion.catch(() => { completion = undefined; });
    return completion;
  };
  const preserve = async () => { await finalize().catch(() => undefined); };
  return { stop, discard, preserve };
}
