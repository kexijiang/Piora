import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { allocatePioraPort } from "../runtime/local-port";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, credentials, type ClientReadableStream } from "@grpc/grpc-js";
import { ScrcpyServiceService } from "hypium-driver/build/lib/generated/scrcpy/scrcpy_grpc_pb.js";
import type { CommandResult } from "../command-runner";
import { HarmonyError } from "../errors";
import { HosVideoPacketizer } from "../media/hos-packets";
import { readDebugVideoLibraryCandidates, type DebugVideoLibrary } from "../runtime/deveco-video-library";
import { videoStartupDiagnostics } from "../runtime/video-startup-diagnostics";
import { VideoOwnership } from "../runtime/video-ownership";
import type { HarmonyVideoConnection } from "../types";
import { MirrorSubscriber } from "./subscriber";
import { MIRROR_PROFILE, captureArguments } from "./profile";

const SOCKET = "localabstract:scrcpy_grpc_socket";
const MAX_QUEUE = 8 * 1024 * 1024;
type Run = (args: readonly string[], operation: string, signal?: AbortSignal, timeout?: number) => Promise<CommandResult>;
type Reply = { getPayloadMap(): { get(key: string): { getValBytes_asU8(): Uint8Array } | undefined } };
const decode = ScrcpyServiceService.onStart.responseDeserialize as unknown as (bytes: Buffer) => Reply;
const fail = (message: string) => new HarmonyError("CAPABILITY_UNAVAILABLE", message, { details: { reason: "debug-video-unavailable" }, retryable: true });
const workingLibraries = new Map<string, string>();

/** One owned HDC encoder per device. Recording and visible viewers have independent lifetimes. */
export class MirrorCaptureSession {
  private readonly viewers = new Set<MirrorSubscriber>();
  private readonly packetizer = new HosVideoPacketizer(MIRROR_PROFILE.fps);
  private configuration?: Buffer;
  private rpc?: Client;
  private source?: ClientReadableStream<Reply>;
  private closing?: Promise<void>;
  private closingStarted = false;
  private pid?: number;
  private forwarded = false;
  private forwardPending = false;
  private shared = false;
  private failed?: Error;
  private lastKeyframeRequest = -Infinity;
  private keyframePending = false;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private idleFrameTimer?: ReturnType<typeof setInterval>;
  private lastFrameAt = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private ownership?: VideoOwnership;
  private journaled = false;
  private libraryToRemember?: { key: string; sha256: string };
  private readonly startupHilogSeen = new Set<string>();
  private constructor(private readonly serial: string, private readonly run: Run, private readonly port: number,
    private readonly name: string, private readonly onClose: () => void) {}

  get whenClosing(): Promise<void> | undefined { return this.closing; }

  static async start(serial: string, source: string | undefined, run: Run, onClose: () => void, ownershipDirectory?: string, knownVersion?: string, scale = MIRROR_PROFILE.scale): Promise<MirrorCaptureSession> {
    captureArguments(scale);
    const session = new MirrorCaptureSession(serial, run, await allocatePioraPort(), `piora_video_${randomUUID().replaceAll("-", "")}.so`, onClose);
    try {
      session.ownership = new VideoOwnership(serial, session.name, session.port, run, ownershipDirectory);
      await session.ownership.prepare(); session.journaled = true;
      await session.initialize(source, knownVersion, scale); return session;
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

  private async initialize(source: string | undefined, knownVersion?: string, scale = MIRROR_PROFILE.scale) {
    const sockets = await this.shell("cat /proc/net/unix", "debug_video_socket_check");
    if (sockets.includes("@scrcpy_grpc_socket")) {
      // Subscribe to the existing service without taking ownership of its daemon.
      // Persist this distinction before creating a forward so crash recovery can
      // remove only our own forward while the other viewer remains connected.
      this.ownership!.markShared();
      this.shared = true;
      await this.openForward();
      return;
    }
    if (!source) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The native video runtime is missing. Repair or update Piora and reconnect.", { details: { reason: "debug-video-sdk-missing" }, retryable: true });
    const version = knownVersion || await this.shell("uitest --version", "debug_video_version");
    const candidates = await readDebugVideoLibraryCandidates(source, version).catch(() => {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "No compatible, verified native video library is available for this device. Repair or update Piora.", {
        details: { reason: "debug-video-library-unavailable", deviceVersion: version.slice(0, 64) }, retryable: false,
      });
    });
    const key = JSON.stringify([this.serial, version, source]);
    const working = workingLibraries.get(key);
    candidates.sort((a, b) => Number(b.sha256 === working) - Number(a.sha256 === working));
    const attempts: Record<string, unknown>[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const library = candidates[index];
      try {
        await this.initializeOwnedLibrary(library, version, scale);
        this.libraryToRemember = { key, sha256: library.sha256 };
        return;
      } catch (error) {
        if (!(error instanceof HarmonyError) || error.details?.reason !== "debug-video-abi-incompatible") throw error;
        attempts.push({ library: library.name, librarySha256: library.sha256,
          missingSymbol: error.details.missingSymbol, diagnostic: error.details.diagnostic });
        if (index === candidates.length - 1) throw new HarmonyError(error.code, error.message, {
          cause: error, details: { ...error.details, libraryAttempts: attempts }, retryable: false,
        });
        // Loader failures normally leave no daemon. Never replace a live own
        // library, steal a foreign socket, or retry unrelated startup errors.
        if (await this.ownsProcess()) throw error;
        if ((await this.shell("cat /proc/net/unix", "debug_video_fallback_socket")).includes("@scrcpy_grpc_socket")) {
          throw new HarmonyError("DEVICE_BUSY", "Another tool owns the debug video channel", { details: { reason: "debug-video-busy" } });
        }
        await this.shell(`rm -f /data/local/tmp/${this.name} /data/local/tmp/${this.name}.log`, "debug_video_fallback_cleanup");
      }
    }
  }

  private async initializeOwnedLibrary(library: DebugVideoLibrary, version: string, scale: typeof MIRROR_PROFILE.scale) {
    const directory = await mkdtemp(join(tmpdir(), "piora-video-"));
    try {
      const path = join(directory, this.name); await writeFile(path, library.bytes, { flag: "wx", mode: 0o600 });
      await this.run(["-t", this.serial, "file", "send", path, `/data/local/tmp/${this.name}`], "debug_video_upload", undefined, 8000);
    } finally { await rm(directory, { recursive: true, force: true }); }
    // Both the bundled Hypium library and the optional SDK expose this capture service.
    const pid = await this.shell(`uitest start-daemon singleness --extension-name ${this.name} ${captureArguments(scale)} > /data/local/tmp/${this.name}.log 2>&1 & echo $!`, "debug_video_start");
    const match = /^\s*(\d+)\s*$/.exec(pid);
    if (!match) throw await this.startupFailure(library, version);
    // uitest daemonizes: $! identifies the launcher, not the long-lived child.
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await this.shell("cat /proc/net/unix", "debug_video_ready")).includes("@scrcpy_grpc_socket")) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready || !await this.ownsProcess()) throw await this.startupFailure(library, version);
    await this.openForward();
  }

  private async startupFailure(library: DebugVideoLibrary, version: string): Promise<HarmonyError> {
    const read = async (command: string, operation: string) => {
      try {
        const result = await this.run(["-t", this.serial, "shell", command], operation, undefined, 2000);
        return result.stdout.toString("utf8").slice(-8192);
      } catch { return ""; }
    };
    const [ownLog, hilog] = await Promise.all([
      read(`tail -c 8192 /data/local/tmp/${this.name}.log 2>/dev/null`, "debug_video_startup_log"),
      read(`hilog -x | grep -F '${this.name}' | tail -c 8192`, "debug_video_startup_hilog"),
    ]);
    const hilogLines = hilog.split(/\r?\n/);
    const currentHilog = hilogLines.filter(line => !this.startupHilogSeen.has(line));
    for (const line of hilogLines) this.startupHilogSeen.add(line);
    const evidence = videoStartupDiagnostics(this.name, ownLog, currentHilog.join("\n"));
    return new HarmonyError("CAPABILITY_UNAVAILABLE", evidence.missingSymbol
      ? `The native video library could not load: ${evidence.missingSymbol}: symbol not found`
      : "The native video service could not start on this device.", {
      details: { reason: evidence.missingSymbol ? "debug-video-abi-incompatible" : "debug-video-start-failed",
        library: library.name, librarySha256: library.sha256, librarySource: library.source,
        deviceVersion: version.slice(0, 64), ...evidence }, retryable: false,
    });
  }

  private async openForward() {
    // A failed HDC response can be ambiguous: retain the journal until a
    // later recovery checks whether the forward was actually created.
    this.forwardPending = true;
    await this.run(["-t", this.serial, "fport", `tcp:${this.port}`, SOCKET], "debug_video_forward", undefined, 8000);
    this.forwarded = true;
    this.forwardPending = false;
    this.rpc = new Client(`127.0.0.1:${this.port}`, credentials.createInsecure(), { "grpc.max_receive_message_length": MAX_QUEUE });
  }

  private startReading() {
    if (this.source || !this.rpc) return;
    this.source = this.rpc.makeServerStreamRequest("/ScrcpyService/onStart", () => Buffer.alloc(0), decode, Buffer.alloc(0));
    this.lastFrameAt = performance.now();
    this.idleFrameTimer = setInterval(() => {
      if (this.viewers.size && performance.now() - this.lastFrameAt >= MIRROR_PROFILE.idleKeyframeIntervalMs) this.requestKeyframe();
    }, MIRROR_PROFILE.idleKeyframeIntervalMs);
    this.idleFrameTimer.unref?.();
    this.firstFrameTimer = setTimeout(() => this.end(fail("The native debug video channel produced no frames. Reconnect the device and update Piora.")), 8000);
    this.source.on("data", (reply: Reply) => {
      if (this.closing) return;
      try {
        const bytes = reply.getPayloadMap().get("data")?.getValBytes_asU8();
        if (!bytes) return;
        for (const packet of this.packetizer.push(Buffer.from(bytes))) {
          const config = packet.readUInt32BE(0) === 2;
          if (config) this.configuration = packet;
          else {
            clearTimeout(this.firstFrameTimer); this.lastFrameAt = performance.now();
            // A loaded daemon alone is insufficient: remember its ABI only
            // after receiving a complete video packet from this device.
            if (this.libraryToRemember) {
              const { key, sha256 } = this.libraryToRemember;
              workingLibraries.delete(key); workingLibraries.set(key, sha256);
              while (workingLibraries.size > 32) workingLibraries.delete(workingLibraries.keys().next().value!);
              this.libraryToRemember = undefined;
            }
          }
          for (const viewer of this.viewers) viewer.push(packet);
        }
      } catch { this.end(fail("The debug video service returned invalid video data")); }
    });
    this.source.on("error", error => { if (!this.closing) this.end(fail(`The debug video connection failed: ${error.message.slice(0, 200)}`)); });
    this.source.on("end", () => { if (!this.closing) this.end(fail("The phone ended the debug video connection")); });
  }

  subscribe(signal?: AbortSignal, recording = false): HarmonyVideoConnection {
    if (this.closing || this.failed) throw this.failed ?? fail("The debug video session is closing");
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    const viewer = new MirrorSubscriber({ recording, requestKeyframe: () => this.requestKeyframe(), onClose: () => {
      signal?.removeEventListener("abort", abort); this.viewers.delete(viewer);
      if (this.viewers.size || this.closingStarted) return;
      if (this.failed) void this.close().catch(() => undefined);
      else {
        this.idleTimer = setTimeout(() => { void this.close().catch(() => undefined); }, MIRROR_PROFILE.reconnectGraceMs);
        this.idleTimer.unref?.();
      }
    } });
    const abort = () => viewer.close();
    this.viewers.add(viewer);
    if (this.configuration) viewer.push(this.configuration);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else {
      this.startReading();
      if (this.configuration) this.requestKeyframe();
    }
    return { stream: viewer.stream, close: async () => viewer.close(), requestKeyframe: () => this.requestKeyframe() };
  }

  requestKeyframe(): void {
    const now = performance.now();
    if (!this.rpc || this.closing || this.keyframePending || now - this.lastKeyframeRequest < MIRROR_PROFILE.keyframeRequestIntervalMs) return;
    this.lastKeyframeRequest = now; this.keyframePending = true;
    this.rpc.makeUnaryRequest("/ScrcpyService/onRequestIDRFrame", () => Buffer.alloc(0), bytes => bytes, Buffer.alloc(0),
      { deadline: Date.now() + 1000 }, () => { this.keyframePending = false; });
  }

  private end(error: Error) {
    this.failed = error;
    for (const viewer of [...this.viewers]) viewer.close(error);
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    this.closingStarted = true;
    return this.closing ??= (async () => {
      clearTimeout(this.idleTimer); this.idleTimer = undefined;
      clearTimeout(this.firstFrameTimer);
      clearInterval(this.idleFrameTimer);
      for (const viewer of [...this.viewers]) viewer.close();
      this.source?.cancel(); this.rpc?.close();
      // Never terminate another IDE's global uitest service or remove its forwarding rules.
      const stopped = async () => {
        if (await this.ownsProcess()) await this.shell(`kill -9 ${this.pid}`, "debug_video_stop");
        await this.shell(`rm -f /data/local/tmp/${this.name} /data/local/tmp/${this.name}.log`, "debug_video_file_cleanup");
      };
      const cleanup = await Promise.allSettled([
        this.shared ? Promise.resolve() : stopped().catch(() => stopped()),
        this.forwarded ? this.run(["-t", this.serial, "fport", "rm", `tcp:${this.port}`, SOCKET], "debug_video_forward_cleanup", undefined, 8000) : Promise.resolve(),
      ]);
      try {
        const failed = cleanup.find(result => result.status === "rejected");
        if (!failed && !this.forwardPending) this.ownership?.clear();
        // The host reader is closed even if an unplugged phone cannot acknowledge
        // cleanup. Preserve the durable journal for reconnect, while allowing the
        // independent MP4 writer to finalize already received frames offline.
        else if (!this.journaled && failed?.status === "rejected") throw failed.reason;
      } finally {
        try { this.ownership?.release(); } finally { this.onClose(); }
      }
    })();
  }
}
