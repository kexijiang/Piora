import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, credentials, type ClientReadableStream } from "@grpc/grpc-js";
import { ScrcpyServiceService } from "hypium-driver/build/lib/generated/scrcpy/scrcpy_grpc_pb.js";
import type { CommandResult } from "./command-runner";
import { HarmonyError } from "./errors";
import { HosVideoPacketizer } from "./media/hos-packets";
import { readDevEcoVideoLibrary } from "./runtime/deveco-video-library";
import { VideoOwnership } from "./runtime/video-ownership";
import type { HarmonyVideoConnection } from "./types";

const SOCKET = "localabstract:scrcpy_grpc_socket";
const MAX_QUEUE = 8 * 1024 * 1024;
type Run = (args: readonly string[], operation: string, signal?: AbortSignal, timeout?: number) => Promise<CommandResult>;
type Reply = { getPayloadMap(): { get(key: string): { getValBytes_asU8(): Uint8Array } | undefined } };
const decode = ScrcpyServiceService.onStart.responseDeserialize as unknown as (bytes: Buffer) => Reply;
const fail = (message: string) => new HarmonyError("CAPABILITY_UNAVAILABLE", message, { details: { reason: "debug-video-unavailable" }, retryable: true });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve((address as { port: number }).port));
    });
  });
}

interface Viewer { controller: ReadableStreamDefaultController<Uint8Array>; ready: boolean; finish(error?: Error): Promise<void> }

/** One owned HDC encoder per device. Recording and visible viewers have independent lifetimes. */
export class DevEcoVideoSession {
  private readonly viewers = new Set<Viewer>();
  private readonly packetizer = new HosVideoPacketizer();
  private configuration?: Buffer;
  private rpc?: Client;
  private source?: ClientReadableStream<Reply>;
  private closing?: Promise<void>;
  private pid?: number;
  private forwarded = false;
  private failed?: Error;
  private startedAt = Date.now();
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private ownership?: VideoOwnership;
  private journaled = false;
  private constructor(private readonly serial: string, private readonly run: Run, private readonly port: number,
    private readonly name: string, private readonly onClose: () => void) {}

  get whenClosing(): Promise<void> | undefined { return this.closing; }

  static async start(serial: string, jar: string, run: Run, onClose: () => void, ownershipDirectory?: string): Promise<DevEcoVideoSession> {
    const session = new DevEcoVideoSession(serial, run, await freePort(), `piora_video_${randomUUID().replaceAll("-", "")}.so`, onClose);
    try {
      session.ownership = new VideoOwnership(serial, session.name, session.port, run, ownershipDirectory);
      await session.ownership.prepare(); session.journaled = true;
      await session.initialize(jar); return session;
    }
    catch (error) { await session.close(); throw error; }
  }

  private async shell(command: string, operation: string) {
    const result = await this.run(["-t", this.serial, "shell", command], operation, undefined, 8000);
    return result.stdout.toString("utf8").replace(/\0/g, "");
  }

  private async ownsProcess(): Promise<boolean> {
    const processes = await this.shell("ps -ef", "debug_video_owner");
    const matches = processes.split(/\r?\n/).filter(line => {
      const fields = line.trim().split(/\s+/);
      return /^\d+$/.test(fields[1]) && fields.includes(this.name) && fields.includes("--extension-name") && fields.includes("uitest");
    });
    if (matches.length !== 1) return false;
    const pid = Number(matches[0].trim().split(/\s+/)[1]);
    if (this.pid && this.pid !== pid) return false;
    this.pid = pid;
    return true;
  }

  private async initialize(jar: string) {
    const version = await this.shell("uitest --version", "debug_video_version");
    const library = await readDevEcoVideoLibrary(jar, version).catch(() => {
      throw fail("This DevEco SDK has no usable debug video library for this phone. Update DevEco Studio and reconnect.");
    });
    const sockets = await this.shell("cat /proc/net/unix", "debug_video_socket_check");
    if (sockets.includes("@scrcpy_grpc_socket")) throw new HarmonyError("DEVICE_BUSY", "Another development tool is using this phone's video channel. Close its mirror before reconnecting.", { details: { reason: "debug-video-busy" } });
    const directory = await mkdtemp(join(tmpdir(), "piora-video-"));
    try {
      const path = join(directory, this.name); await writeFile(path, library, { flag: "wx", mode: 0o600 });
      await this.run(["-t", this.serial, "file", "send", path, `/data/local/tmp/${this.name}`], "debug_video_upload", undefined, 8000);
    } finally { await rm(directory, { recursive: true, force: true }); }
    // This is the SDK's development capture service, not an app or an input-control session.
    const pid = await this.shell(`uitest start-daemon singleness --extension-name ${this.name} -scale 1 -frameRate 30 -bitRate 6291456 -p 5000 -iFrameInterval 2000 -repeatInterval 33 > /data/local/tmp/${this.name}.log 2>&1 & echo $!`, "debug_video_start");
    const match = /^\s*(\d+)\s*$/.exec(pid);
    if (!match) throw fail("The phone did not identify the debug video service");
    // uitest daemonizes: $! identifies the launcher, not the long-lived child.
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await this.shell("cat /proc/net/unix", "debug_video_ready")).includes("@scrcpy_grpc_socket")) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready || !await this.ownsProcess()) throw fail("The DevEco debug video service could not start on this system. Update DevEco Studio and reconnect.");
    await this.run(["-t", this.serial, "fport", `tcp:${this.port}`, SOCKET], "debug_video_forward", undefined, 8000);
    this.forwarded = true;
    this.rpc = new Client(`127.0.0.1:${this.port}`, credentials.createInsecure(), { "grpc.max_receive_message_length": MAX_QUEUE });
  }

  private startReading() {
    if (this.source || !this.rpc) return;
    this.startedAt = Date.now();
    this.source = this.rpc.makeServerStreamRequest("/ScrcpyService/onStart", () => Buffer.alloc(0), decode, Buffer.alloc(0));
    this.firstFrameTimer = setTimeout(() => this.end(fail("The DevEco debug video channel produced no frames. Update DevEco Studio and reconnect.")), 8000);
    this.source.on("data", (reply: Reply) => {
      if (this.closing) return;
      try {
        const bytes = reply.getPayloadMap().get("data")?.getValBytes_asU8();
        if (!bytes) return;
        for (const packet of this.packetizer.push(Buffer.from(bytes))) {
          const config = packet.readUInt32BE(0) === 2;
          if (config) this.configuration = packet;
          else { clearTimeout(this.firstFrameTimer); }
          for (const viewer of this.viewers) {
            if (config) { viewer.ready = false; viewer.controller.enqueue(packet); continue; }
            if (!viewer.ready) { if (!packet[8]) continue; viewer.ready = true; }
            if ((viewer.controller.desiredSize ?? 0) < packet.length) {
              void viewer.finish(fail("The video consumer is too slow; reconnect to resume live frames.")).catch(() => undefined);
            } else viewer.controller.enqueue(packet);
          }
        }
      } catch { this.end(fail("The debug video service returned invalid video data")); }
    });
    this.source.on("error", error => { if (!this.closing) this.end(fail(`The debug video connection failed: ${error.message.slice(0, 200)}`)); });
    this.source.on("end", () => { if (!this.closing) this.end(fail("The phone ended the debug video connection")); });
  }

  subscribe(signal?: AbortSignal, recording = false): HarmonyVideoConnection {
    if (this.closing || this.failed) throw this.failed ?? fail("The debug video session is closing");
    let viewer: Viewer, finished = false;
    const finish = async (error?: Error) => {
      if (finished) return this.closing;
      finished = true; signal?.removeEventListener("abort", abort); this.viewers.delete(viewer);
      try { if (error) viewer.controller.error(error); else viewer.controller.close(); } catch { /* cancelled reader */ }
      if (!this.viewers.size) await this.close();
    };
    const abort = () => { void finish().catch(() => undefined); };
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        viewer = { controller, ready: false, finish }; this.viewers.add(viewer);
        // The host owns the encoder and implements the same isolation contract:
        // closing a viewer cannot stop an independent recording subscriber.
        if (recording) controller.enqueue(Uint8Array.from([0, 0, 0, 0x21, 0, 0, 0, 1, 1]));
        if (this.configuration) controller.enqueue(this.configuration);
      }, cancel: () => finish(),
    }, { highWaterMark: MAX_QUEUE, size: chunk => chunk.byteLength });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else {
      this.startReading();
      if (this.configuration && Date.now() - this.startedAt > 200) {
        this.rpc?.makeUnaryRequest("/ScrcpyService/onRequestIDRFrame", () => Buffer.alloc(0), bytes => bytes, Buffer.alloc(0), { deadline: Date.now() + 1000 }, () => {});
      }
    }
    return { stream, close: () => finish() };
  }

  private end(error: Error) {
    this.failed = error;
    for (const viewer of [...this.viewers]) void viewer.finish(error).catch(() => undefined);
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      clearTimeout(this.firstFrameTimer);
      this.source?.cancel(); this.rpc?.close();
      // Never terminate another IDE's global uitest service or remove its forwarding rules.
      const stopped = async () => {
        if (await this.ownsProcess()) await this.shell(`kill -9 ${this.pid}`, "debug_video_stop");
        await this.shell(`rm -f /data/local/tmp/${this.name} /data/local/tmp/${this.name}.log`, "debug_video_file_cleanup");
      };
      const cleanup = await Promise.allSettled([
        stopped().catch(() => stopped()),
        this.forwarded ? this.run(["-t", this.serial, "fport", "rm", `tcp:${this.port}`, SOCKET], "debug_video_forward_cleanup", undefined, 8000) : Promise.resolve(),
      ]);
      try {
        const failed = cleanup.find(result => result.status === "rejected");
        if (!failed) this.ownership?.clear();
        // The host reader is closed even if an unplugged phone cannot acknowledge
        // cleanup. Preserve the durable journal for reconnect, while allowing the
        // independent MP4 writer to finalize already received frames offline.
        else if (!this.journaled && failed.status === "rejected") throw failed.reason;
      } finally {
        try { this.ownership?.release(); } finally { this.onClose(); }
      }
    })();
  }
}
