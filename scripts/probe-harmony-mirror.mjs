import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf("="); return [arg.slice(0, at), arg.slice(at + 1)]; }));
if (!args["--hdc"] || !args["--serial"]) throw new Error("Pass --hdc=absolute-path --serial=authorized-device [--seconds=15] [--output=directory]");
const duration = Number(args["--seconds"] ?? 15);
if (!Number.isFinite(duration) || duration < 1 || duration > 600) throw new Error("Probe duration must be 1–600 seconds");
const directory = resolve(args["--output"] ?? ".verification/mirror-probe");
await mkdir(directory, { recursive: true });
const jiti = createJiti(import.meta.url);
const { MirrorCaptureSession } = await jiti.import("../lib/harmony/mirror/capture-session.ts");
const { findDebugVideoSource } = await jiti.import("../lib/harmony/runtime/deveco-video-library.ts");
const execute = promisify(execFile);
const commands = [];
const run = async (argv, operation, signal, timeout = 8000) => {
  const started = performance.now();
  const result = await execute(args["--hdc"], argv, { encoding: "buffer", windowsHide: true, timeout, signal, maxBuffer: 2 * 1024 * 1024 });
  commands.push({ operation, durationMs: performance.now() - started });
  return { ...result, exitCode: 0, durationMs: performance.now() - started };
};
const source = await findDebugVideoSource(args["--hdc"]);
let session, reader, timer;
const timestamps = [], sizes = [], configs = [], sample = [];
let sampleBytes = 0, stopped = false;
const startedAt = performance.now();
try {
  session = await MirrorCaptureSession.start(args["--serial"], source, run, () => {});
  const connection = session.subscribe(); reader = connection.stream.getReader();
  timer = setTimeout(() => { stopped = true; void reader.cancel(); }, duration * 1000);
  while (!stopped) {
    const next = await reader.read(); if (next.done) break;
    const bytes = Buffer.from(next.value), type = bytes.readUInt32BE(0);
    if (type === 2) configs.push({ width: bytes.readUInt32BE(9), height: bytes.readUInt32BE(13), requestedFps: bytes.readUInt32BE(17) });
    if (type === 3) { timestamps.push(performance.now()); sizes.push(bytes.length); }
    if (args["--sample"] === "true" && sampleBytes + bytes.length <= 64 * 1024 * 1024) { sample.push(bytes); sampleBytes += bytes.length; }
  }
} finally {
  clearTimeout(timer); await reader?.cancel().catch(() => {}); await session?.close();
}
const intervals = timestamps.slice(1).map((time, index) => time - timestamps[index]).sort((a, b) => a - b);
const result = { started: new Date().toISOString(), durationSeconds: duration, firstFrameMs: timestamps[0] - startedAt,
  frames: timestamps.length, receivedFps: timestamps.length > 1 ? (timestamps.length - 1) * 1000 / (timestamps.at(-1) - timestamps[0]) : 0,
  frameIntervalP95Ms: intervals[Math.floor(intervals.length * .95)] ?? null,
  megabitsPerSecond: sizes.reduce((a, b) => a + b, 0) * 8 / duration / 1e6,
  configs, commands, boundary: "HDC/gRPC encoded frame arrival only. Not decoded/presented FPS or end-to-end latency." };
await writeFile(resolve(directory, "probe.json"), JSON.stringify(result, null, 2));
if (sample.length) await writeFile(resolve(directory, "capture.bin"), Buffer.concat(sample));
console.log(JSON.stringify(result, null, 2));
