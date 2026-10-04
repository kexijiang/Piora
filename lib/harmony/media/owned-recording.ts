import { open, copyFile, mkdtemp, rm, rmdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedPacket } from "mediabunny";
import { asHarmonyError, HarmonyError } from "../errors";
import type { HarmonyVideoConnection } from "../types";

const MAX_BYTES = 256 * 1024 * 1024;
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
  if (payload.length < 17 || payload[0] !== 0) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Owned MP4 recording requires the mirror's H.264 stream; no system recorder will be toggled", { details: { dispatchState: "not-sent" } });
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

/** Records only this subscriber's encoded stream. No global recorder, process kill or device media deletion. */
export async function startOwnedRecording(connection: HarmonyVideoConnection, signal?: AbortSignal, onFailure?: (error: HarmonyError) => void) {
  const directory = await mkdtemp(join(tmpdir(), "piora-owned-recording-"));
  const path = join(directory, "capture.mp4");
  const handle = await open(path, "wx", 0o600).catch(async error => { await rmdir(directory); await connection.close(); throw error; });
  const source = new EncodedVideoPacketSource("avc");
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(new WritableStream({
    async write(chunk) {
      if (chunk.position + chunk.data.length > MAX_BYTES) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording reached its 256 MiB limit");
      let offset = 0;
      while (offset < chunk.data.length) { const result = await handle.write(chunk.data, offset, chunk.data.length - offset, chunk.position + offset); if (!result.bytesWritten) throw new Error("Recording write made no progress"); offset += result.bytesWritten; }
    },
  }), { chunked: true, chunkSize: 1024 * 1024 }) });
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { output.addVideoTrack(source); await output.start(); reader = connection.stream.getReader(); }
  catch (error) { await output.cancel().catch(() => undefined); await handle.close(); await rm(path, { force: true }); await rmdir(directory); await connection.close(); throw error; }
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
      try { onFailure(new HarmonyError(error.code, error.message, { details: { ...error.details, recordingStopped: true } })); }
      catch { /* Observer errors do not change the recording's retained failure. */ }
    });
  };
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
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
  let pending = Buffer.alloc(0);
  const pump = (async () => {
    try {
      while (!stopping && !failure) {
        const { done, value } = await reader.read();
        if (done) { if (!stopping) throw new HarmonyError("DEVICE_OFFLINE", "Recording stream ended before stop"); break; }
        if (pending.length + value.length > MAX_PACKET + 8) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording packet buffer exceeded limit");
        pending = Buffer.concat([pending, value]);
        while (pending.length >= 8) {
          const type = pending.readUInt32BE(0), length = pending.readUInt32BE(4);
          if (length > MAX_PACKET) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording packet exceeded limit");
          if (pending.length < length + 8) break;
          const payload = pending.subarray(8, length + 8); pending = pending.subarray(length + 8);
          if (type === 2) {
            const next = configuration(payload);
            if (config && (next.width !== config.width || next.height !== config.height || !next.description.equals(config.description))) throw new HarmonyError("STALE_SNAPSHOT", "Video geometry or codec changed; stop and start a new recording");
            config = next;
          } else if (type === 3 && config && payload.length > 9) {
            const key = Boolean(payload[0] & 1), timestamp = Number(payload.readBigUInt64BE(1));
            if (!frames && !key) continue;
            if (!Number.isSafeInteger(timestamp) || frames >= 14400) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording timestamp or frame limit exceeded");
            firstTimestamp ??= timestamp;
            const relative = (timestamp - firstTimestamp) / 1_000_000;
            if (relative < 0 || relative > 120) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording reached its two-minute limit");
            await source.add(new EncodedPacket(lengthPrefixed(payload.subarray(9)), key ? "key" : "delta", relative, 1 / config.fps), frames ? undefined : { decoderConfig: { codec: config.codec, codedWidth: config.width, codedHeight: config.height, description: config.description } });
            frames++; resolveReady();
          }
        }
      }
    } catch (error) { failure ??= error; rejectReady(error); }
    finally {
      await close().catch(error => {
        const original = failure ? asHarmonyError(failure) : asHarmonyError(error);
        failure = new HarmonyError(original.code, original.message, { cause: error,
          details: { ...original.details, cleanup: "uncertain", recordingStopped: true } });
      });
      ended = true; reportFailure();
    }
  })();
  if (signal?.aborted) abort();
  let discardPromise: Promise<void> | undefined;
  let completion: Promise<number> | undefined;
  const discard = () => discardPromise ??= (async () => {
    if (completion) { await completion.catch(() => undefined); return; }
    stopping = true;
    try { await close(); }
    finally { await pump; await output.cancel().catch(() => undefined); await handle.close(); await rm(path, { force: true }); await rmdir(directory); }
  })();
  try { await ready; }
  catch (error) { await discard(); throw error; }
  finally { clearTimeout(startup); signal?.removeEventListener("abort", abort); }
  accepted = true; reportFailure();
  const stop = (destination: string) => completion ??= (async () => {
    stopping = true;
    try {
      await close(); await pump;
      if (failure) throw failure;
      source.close(); await output.finalize(); await handle.close();
      await copyFile(path, destination, constants.COPYFILE_EXCL);
      return (await stat(destination)).size;
    } finally {
      await pump;
      if (output.state !== "finalized") await output.cancel().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(path, { force: true }); await rmdir(directory);
    }
  })();
  return { stop, discard };
}
