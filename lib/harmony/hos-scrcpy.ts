import { spawn, type ChildProcessByStdio } from "node:child_process";
import { lstat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import { HarmonyError } from "./errors";
import { HosVideoPacketizer } from "./media/hos-packets";
import type { HarmonyVideoConnection } from "./types";

const MAX_SIDE_CAR_OUTPUT = 16 * 1024;
const MAX_JAR_BYTES = 128 * 1024 * 1024;

async function packageFiles(packageDirectory: string) {
  if (typeof packageDirectory !== "string" || !isAbsolute(packageDirectory) || packageDirectory.length > 4096) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute HOScrcpy package directory");
  }
  const directory = resolve(packageDirectory);
  const jar = join(directory, "resources", "hosScrcpy-1.0.18-beta.jar");
  const classes = join(directory, "resources", "out");
  const [jarStat, classStat] = await Promise.all([lstat(jar).catch(() => undefined), lstat(join(classes, "Main.class")).catch(() => undefined)]);
  if (!jarStat?.isFile() || jarStat.isSymbolicLink() || jarStat.size > MAX_JAR_BYTES || !classStat?.isFile() || classStat.isSymbolicLink()) {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "HOScrcpy SDK jar or sidecar classes are missing; use the bundled HDC video provider");
  }
  return { jar, classes };
}

function waitReady(process: ChildProcessByStdio<null, Readable, Readable>, signal?: AbortSignal): Promise<number> {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error, port?: number) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort);
      process.stdout.off("data", read); process.stderr.off("data", readError);
      process.off("error", failed); process.off("exit", exited);
      if (error) rejectReady(error); else resolveReady(port!);
    };
    const read = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_SIDE_CAR_OUTPUT) return finish(new HarmonyError("INVALID_RESPONSE", "HOScrcpy emitted too much startup output"));
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"ready":true')) continue;
        try {
          const value = JSON.parse(line) as { ready?: boolean; port?: number };
          if (value.ready && Number.isInteger(value.port) && value.port! >= 1024 && value.port! <= 65535) return finish(undefined, value.port);
        } catch { /* Continue until a valid ready line or process failure. */ }
      }
    };
    const readError = (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-MAX_SIDE_CAR_OUTPUT); };
    const failed = (error: Error) => finish(new HarmonyError("CAPABILITY_UNAVAILABLE", "HOScrcpy Java process could not start", { cause: error }));
    const exited = (code: number | null) => finish(new HarmonyError("CAPABILITY_UNAVAILABLE", `HOScrcpy exited before video was ready (${code ?? "unknown"}): ${stderr.slice(-300)}`));
    const abort = () => finish(new HarmonyError("COMMAND_ABORTED", "HOScrcpy video start was cancelled"));
    const timeout = setTimeout(() => finish(new HarmonyError("COMMAND_TIMEOUT", "HOScrcpy video did not become ready within 20 seconds")), 20_000);
    process.stdout.on("data", read); process.stderr.on("data", readError); process.once("error", failed); process.once("exit", exited);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function connect(port: number): Promise<WebSocket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5_000, perMessageDeflate: false });
    socket.once("open", () => { socket.off("error", failed); resolveSocket(socket); });
    const failed = (error: Error) => { socket.terminate(); rejectSocket(error); };
    socket.once("error", failed);
  });
}

/** Piora owns the child and proxies only video through its authenticated HTTP route. */
export async function openHosScrcpyVideo(options: { serial: string; hdcPath: string; packageDirectory: string; javaPath?: string; signal?: AbortSignal; onFailure?: (reason: string) => void }): Promise<HarmonyVideoConnection> {
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(options.serial)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid device serial");
  if (options.signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "HOScrcpy video start was cancelled");
  const { jar, classes } = await packageFiles(options.packageDirectory);
  const javaPath = options.javaPath?.trim() || "java";
  if (javaPath !== "java" && !isAbsolute(javaPath)) throw new HarmonyError("INVALID_ARGUMENT", "Java executable path must be absolute");
  const child = spawn(javaPath, ["-cp", `${jar}${delimiter}${classes}`, "Main", "--sn", options.serial, "--hdc", options.hdcPath,
    "--port", "0", "--scale", "1", "--frame-rate", "30", "--idle-exit", "30"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let socket: WebSocket | undefined;
  try {
    const port = await waitReady(child, options.signal);
    socket = await connect(port);
  } catch (error) { child.kill(); throw error; }
  const ws = socket;
  const converter = new HosVideoPacketizer();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; clearInterval(sizePoll); options.signal?.removeEventListener("abort", abort);
    ws.removeAllListeners(); ws.terminate(); child.kill();
  };
  const abort = () => { try { controller?.close(); } catch { /* Already closed. */ } void close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const sizePoll = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"size"}'); }, 2_000);
  sizePoll.unref?.();
  ws.send('{"type":"size"}');
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      ws.on("message", (data, binary) => {
        if (closed) return;
        if (!binary) {
          try {
            const reply = JSON.parse(data.toString()) as { ok?: boolean; msg?: string; data?: string };
            if (reply.ok && reply.msg === "size") {
              const match = /^(\d{1,5})x(\d{1,5})$/.exec(reply.data ?? "");
              if (match) converter.setSize(Number(match[1]), Number(match[2]));
            }
          } catch { /* Ignore untrusted sidecar diagnostics. */ }
          return;
        }
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        for (const packet of converter.push(bytes)) streamController.enqueue(packet);
        if ((streamController.desiredSize ?? 1) <= 0) ws.pause();
      });
      ws.once("error", error => { if (!closed) { options.onFailure?.(error.message); streamController.error(error); void close(); } });
      ws.once("close", () => { if (!closed) { options.onFailure?.("HOScrcpy video socket closed"); streamController.close(); void close(); } });
      child.once("exit", code => { if (!closed) { options.onFailure?.(`HOScrcpy exited (${code ?? "unknown"})`); streamController.close(); void close(); } });
    },
    pull() { if (!closed) ws.resume(); },
    async cancel() { await close(); },
  });
  return { stream, close };
}
