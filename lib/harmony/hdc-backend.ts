import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { type CommandExecutor, runCommand } from "./command-runner";
import { HarmonyError, isHarmonyError } from "./errors";
import { readHarmonyConfig, resolveHdcPath, type ResolveHdcOptions } from "./runtime";
import { flattenUiTree } from "./ui-tree";
import { streamHdcLines } from "./log-stream";
import type {
  BackendDevice,
  BackendSnapshot,
  HarmonyAutomationBackend,
  HarmonyCapabilities,
  HarmonyDeviceConnectionState,
  HarmonyLogEntry,
  HarmonyLogLevel,
  HarmonyProcess,
  HarmonyScreenshot,
  HarmonyVideoConnection,
} from "./types";

const MAX_LAYOUT_BYTES = 16 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_TEXT_BYTES = 16 * 1024;
const SERIAL_PATTERN = /^[A-Za-z0-9._:\[\]-]{1,256}$/;
const APP_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
const MAX_LOG_QUERY_LENGTH = 256;
const MAX_LOG_LINES = 2_000;
const MIRROR_BUNDLE = "com.ohos.scrcpy.server";
const MIRROR_ABILITY = "ScrcpyService";
const MIRROR_DEVICE_PORT = 53_535;
const MIRROR_MAX_SHORT_EDGE = 1_080;
const MIRROR_BITRATE = 6_000_000;
const MIRROR_FRAME_RATE = 30;

const NO_UITEST_CAPABILITIES: HarmonyCapabilities = {
  uiTree: false,
  screenshot: false,
  tap: false,
  swipe: false,
  inputText: false,
  keys: false,
  launchApp: true,
};

const UITEST_CAPABILITIES: HarmonyCapabilities = {
  uiTree: true,
  screenshot: true,
  tap: false,
  swipe: false,
  // Text travels through a temporary file; it is never interpolated into a command.
  inputText: false,
  keys: false,
  launchApp: true,
};

export interface HdcBackendOptions {
  hdcPath?: string;
  resolve?: ResolveHdcOptions;
  execute?: CommandExecutor;
  commandTimeoutMs?: number;
}

function validateSerial(serial: string): void {
  if (!SERIAL_PATTERN.test(serial)) {
    throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony device serial");
  }
}

function validateCoordinate(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new HarmonyError("INVALID_ARGUMENT", `${label} must be an integer between 0 and 100000`);
  }
  return value;
}

function parseDeviceLine(line: string): { serial: string; state: HarmonyDeviceConnectionState } | undefined {
  const trimmed = line.trim();
  if (!trimmed || /^\[?empty\]?(?:\s|$)/i.test(trimmed) || /no targets/i.test(trimmed)) return undefined;
  if (/^\[(?:fail|error|e\d+)/i.test(trimmed)) return undefined;
  const parts = trimmed.split(/\s+/);
  const serial = parts[0];
  if (!SERIAL_PATTERN.test(serial) || /^(connect|list|targets|device)$/i.test(serial)) return undefined;
  const status = parts.slice(1).join(" ").toLowerCase();
  const state: HarmonyDeviceConnectionState = /unauthor|not.auth/.test(status)
    ? "unauthorized"
    : /offline|disconnect/.test(status)
      ? "offline"
      : "online";
  return { serial, state };
}

function cleanOutput(output: Buffer): string | undefined {
  const value = output.toString("utf8").replace(/\0/g, "").trim();
  return value && !/^(unknown|null|undefined)$/i.test(value) ? value.slice(0, 512) : undefined;
}

function preferredDeviceName(values: Array<string | undefined>, model?: string, product?: string): string | undefined {
  return values.find((value) => value && value !== model && value !== product && !/^(unknown|null|undefined)$/i.test(value))
    ?? values.find(Boolean)
    ?? model
    ?? product;
}

function parseProcessList(output: Buffer): HarmonyProcess[] {
  const processes = new Map<number, HarmonyProcess>();
  for (const line of output.toString("utf8").replace(/\0/g, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:pid|uid)\b/i.test(trimmed)) continue;
    const columns = trimmed.split(/\s+/);
    const pidIndex = columns.findIndex((column) => /^\d+$/.test(column));
    if (pidIndex < 0) continue;
    const pid = Number(columns[pidIndex]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const name = columns.at(-1)?.replace(/^\[|\]$/g, "") || `PID ${pid}`;
    if (!name || /^\d+$/.test(name)) continue;
    processes.set(pid, { pid, name: name.slice(0, 256) });
  }
  return [...processes.values()].sort((left, right) => left.name.localeCompare(right.name) || left.pid - right.pid);
}

const LOG_LEVELS: Record<string, HarmonyLogLevel> = {
  D: "debug",
  I: "info",
  W: "warn",
  E: "error",
  F: "fatal",
};

function parseLogLine(raw: string): HarmonyLogEntry {
  const line = raw.replace(/\0/g, "").trimEnd();
  const match = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(?:(\S+)\/)?([^:]+):\s?(.*)$/)
    ?? line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d+)-(\d+)(?:\/\S+)?\s+([DIWEF])\s+(?:(\S+)\/)?([^:]+):\s?(.*)$/);
  if (!match) return { level: "unknown", message: line, raw: line };
  return {
    timestamp: match[1],
    pid: Number(match[2]),
    tid: Number(match[3]),
    level: LOG_LEVELS[match[4]] ?? "unknown",
    ...(match[5] ? { domain: match[5] } : {}),
    tag: match[6].trim(),
    message: match[7],
    raw: line,
  };
}

function versionAtLeast(version: string | undefined, minimum: readonly number[]): boolean {
  const match = version?.match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const current = match.slice(1, 5).map((value) => Number(value ?? 0));
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function capabilitiesForUiTest(version: string | undefined): HarmonyCapabilities {
  if (!versionAtLeast(version, [1, 0, 0, 0])) return { ...NO_UITEST_CAPABILITIES };
  const supportsCliInput = versionAtLeast(version, [4, 1, 2, 0]);
  return {
    ...UITEST_CAPABILITIES,
    tap: supportsCliInput,
    swipe: supportsCliInput,
    keys: supportsCliInput,
    // Coordinate-free text input was added in UiTest 5.1.1.1.
    inputText: versionAtLeast(version, [5, 1, 1, 1]),
  };
}

function parsePng(data: Buffer): HarmonyScreenshot {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature)) {
    throw new HarmonyError("INVALID_RESPONSE", "Harmony device returned an invalid screenshot");
  }
  return {
    mimeType: "image/png",
    data,
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

function encodeMirrorPacket(type: number, payload: Buffer): Buffer {
  const packet = Buffer.allocUnsafe(8 + payload.length);
  packet.writeUInt32BE(type, 0);
  packet.writeUInt32BE(payload.length, 4);
  payload.copy(packet, 8);
  return packet;
}

function encodeMirrorHeartbeat(): Buffer {
  const payload = Buffer.allocUnsafe(8);
  payload.writeBigUInt64BE(BigInt(Date.now()), 0);
  return encodeMirrorPacket(0x01, payload);
}

function encodeMirrorVideoParameters(): Buffer {
  const payload = Buffer.allocUnsafe(13);
  payload[0] = 0x42;
  payload.writeInt32BE(MIRROR_MAX_SHORT_EDGE, 1);
  payload.writeInt32BE(MIRROR_BITRATE, 5);
  payload.writeInt32BE(MIRROR_FRAME_RATE, 9);
  return encodeMirrorPacket(0x10, payload);
}

export function parseHarmonyForwardedPort(output: string): number | undefined {
  const match = output.match(/tcp:(\d+)\s+tcp:\d+/i) ?? output.match(/localhost:(\d+)/i);
  const port = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Unable to allocate a local Harmony video port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

async function connectLoopback(port: number, signal?: AbortSignal): Promise<Socket> {
  return await new Promise<Socket>((resolveSocket, rejectSocket) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5_000);
    const timeout = setTimeout(() => fail(new Error("Harmony video service connection timed out")), 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.removeListener("connect", connected);
      socket.removeListener("error", fail);
    };
    const connected = () => {
      cleanup();
      resolveSocket(socket);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      rejectSocket(error);
    };
    const abort = () => fail(new Error("Harmony video connection was cancelled"));
    socket.once("connect", connected);
    socket.once("error", fail);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class HdcBackend implements HarmonyAutomationBackend {
  readonly kind = "hdc-uitest";
  readonly hdcPath: string;
  private readonly execute: CommandExecutor;
  private readonly commandTimeoutMs: number;
  private readonly capabilitiesBySerial = new Map<string, HarmonyCapabilities>();
  private readonly deviceInfoBySerial = new Map<string, { device: Omit<BackendDevice, "state">; expiresAt: number }>();
  private readonly liveScreenshotPaths = new Map<string, { directory: string; localPath: string; remotePath: string }>();
  private readonly preparedMirrorServers = new Set<string>();

  constructor(options: HdcBackendOptions = {}) {
    const config = readHarmonyConfig();
    const resolution = resolveHdcPath({
      ...options.resolve,
      explicitPath: options.hdcPath ?? options.resolve?.explicitPath,
      config: options.resolve?.config ?? config,
    });
    this.hdcPath = resolution.hdcPath;
    this.execute = options.execute ?? runCommand;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
  }

  private async run(args: readonly string[], operation: string, signal?: AbortSignal, timeoutMs?: number) {
    const result = await this.execute({
      executable: this.hdcPath,
      args,
      timeoutMs: timeoutMs ?? this.commandTimeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      signal,
      operation,
    });
    // Several HDC releases print a failure marker but still exit with code 0.
    // Treat that protocol response as an error so taps and pulls cannot report
    // false success. An empty target list is the one expected bracketed status.
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
    if (operation !== "list_devices" && operation !== "list_devices_legacy"
      && /(?:^|\r?\n)\s*\[(?:Fail|Error|E\d{3,})\]/i.test(output)) {
      throw new HarmonyError("COMMAND_FAILED", "HDC rejected the device command", {
        details: { operation },
        retryable: true,
      });
    }
    return result;
  }

  private async shell(serial: string, args: readonly string[], operation: string, signal?: AbortSignal, timeoutMs?: number) {
    validateSerial(serial);
    return await this.run(["-t", serial, "shell", ...args], operation, signal, timeoutMs);
  }

  private async safeInfo(serial: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    try {
      const value = cleanOutput((await this.shell(serial, args, "device_info", signal)).stdout);
      // Device shell utilities can print diagnostics and still exit with zero.
      // Those diagnostics are not device names, models, or versions.
      if (!value || /[\r\n]/.test(value)
        || /(?:not found|not exist|permission denied|invalid (?:argument|parameter)|unknown (?:command|option)|get .* fail|^error\b|^usage:|^\/.*(?:sh|shell):)/i.test(value)) return undefined;
      return value;
    } catch (error) {
      if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
      return undefined;
    }
  }

  async listDevices(signal?: AbortSignal): Promise<BackendDevice[]> {
    let result;
    try {
      result = await this.run(["list", "targets", "-v"], "list_devices", signal, 8_000);
    } catch (error) {
      if (!isHarmonyError(error) || error.code !== "COMMAND_FAILED") throw error;
      // Older SDK releases expose list targets but not the verbose flag.
      result = await this.run(["list", "targets"], "list_devices_legacy", signal, 8_000);
    }
    const parsed = result.stdout.toString("utf8").split(/\r?\n/).map(parseDeviceLine).filter(Boolean) as Array<{
      serial: string;
      state: HarmonyDeviceConnectionState;
    }>;
    const unique = [...new Map(parsed.map((device) => [device.serial, device])).values()];
    const online = new Set(unique.filter((device) => device.state === "online").map((device) => device.serial));
    for (const serial of this.deviceInfoBySerial.keys()) {
      if (!online.has(serial)) {
        this.deviceInfoBySerial.delete(serial);
        this.capabilitiesBySerial.delete(serial);
      }
    }

    return await Promise.all(unique.map(async ({ serial, state }): Promise<BackendDevice> => {
      if (state !== "online") {
        return { serial, state, capabilities: { ...NO_UITEST_CAPABILITIES, launchApp: false } };
      }
      const cached = this.deviceInfoBySerial.get(serial);
      if (cached && cached.expiresAt > Date.now()) return { ...cached.device, state };
      const [model, product, userName, persistedName, deviceName, osVersion, apiVersion, uitestVersion] = await Promise.all([
        this.safeInfo(serial, ["param", "get", "const.product.model"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.name"], signal),
        this.safeInfo(serial, ["settings", "get", "secure", "unified_device_name"], signal),
        this.safeInfo(serial, ["param", "get", "persist.sys.device_name"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.devicename"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.software.version"], signal),
        this.safeInfo(serial, ["param", "get", "const.ohos.apiversion"], signal),
        this.safeInfo(serial, ["uitest", "--version"], signal),
      ]);
      const capabilities = capabilitiesForUiTest(uitestVersion);
      this.capabilitiesBySerial.set(serial, capabilities);
      const deviceInfo: Omit<BackendDevice, "state"> = {
        serial,
        model,
        product,
        name: preferredDeviceName([userName, persistedName, deviceName], model, product),
        osVersion,
        apiVersion,
        uitestVersion,
        capabilities,
      };
      this.deviceInfoBySerial.set(serial, { device: deviceInfo, expiresAt: Date.now() + 30_000 });
      return { ...deviceInfo, state };
    }));
  }

  async listProcesses(serial: string, signal?: AbortSignal): Promise<HarmonyProcess[]> {
    validateSerial(serial);
    try {
      return parseProcessList((await this.shell(serial, ["ps", "-A", "-o", "PID,NAME"], "list_processes", signal,)).stdout);
    } catch (error) {
      if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
      return parseProcessList((await this.shell(serial, ["ps", "-ef"], "list_processes_legacy", signal)).stdout);
    }
  }

  async readLogs(
    serial: string,
    options: { pid?: number; level?: Exclude<HarmonyLogLevel, "unknown">; query?: string; limit?: number; signal?: AbortSignal },
  ): Promise<HarmonyLogEntry[]> {
    validateSerial(serial);
    const limit = Math.max(1, Math.min(MAX_LOG_LINES, Math.round(options.limit ?? 400)));
    if (options.pid !== undefined && (!Number.isSafeInteger(options.pid) || options.pid <= 0)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Harmony log PID must be a positive integer");
    }
    const query = options.query?.trim().slice(0, MAX_LOG_QUERY_LENGTH).toLocaleLowerCase();
    // -z/--tail is the bounded query option. -n configures the number of
    // persisted log files and therefore made the former command invalid.
    const args = ["hilog", "-z", String(limit), "-v", "time"];
    if (options.pid !== undefined) args.push("-P", String(options.pid));
    if (options.level) args.push("-L", { debug: "D", info: "I", warn: "W", error: "E", fatal: "F" }[options.level]);
    const result = await this.shell(serial, args, "read_logs", options.signal, 10_000);
    return result.stdout.toString("utf8")
      .split(/\r?\n/)
      .map(parseLogLine)
      .filter((entry) => entry.raw.length > 0)
      .filter((entry) => {
        if (!options.level || entry.level === "unknown") return true;
        const severity = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 } as const;
        return severity[entry.level] >= severity[options.level];
      })
      .filter((entry) => !query || entry.raw.toLocaleLowerCase().includes(query))
      .slice(-limit);
  }

  async streamLogs(serial: string, onEntries: (entries: HarmonyLogEntry[]) => void, signal?: AbortSignal): Promise<void> {
    validateSerial(serial);
    await streamHdcLines(this.hdcPath, ["-t", serial, "shell", "hilog", "-v", "time"], (lines) => {
      const entries = lines.filter(Boolean).map(parseLogLine);
      if (entries.length) onEntries(entries);
    }, signal);
  }

  private async pullGeneratedFile(
    serial: string,
    remotePath: string,
    operation: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), "piora-harmony-"));
    const localPath = join(directory, operation === "screenshot" ? "screen.png" : "layout.json");
    try {
      // UiTest creates screenshots under /data/local/tmp with permissions that
      // HDC can read. Avoiding a redundant chmod removes one full HDC process
      // launch from every live-view frame; layout dumps keep the defensive
      // permission normalization because they may contain application text.
      if (operation !== "screenshot") {
        await this.shell(serial, ["chmod", "600", remotePath], `${operation}_protect`, signal);
      }
      await this.run(["-t", serial, "file", "recv", remotePath, localPath], `${operation}_pull`, signal, 20_000);
      const info = await stat(localPath);
      if (info.size <= 0 || info.size > maxBytes) {
        throw new HarmonyError("INVALID_RESPONSE", `Harmony ${operation} file has an invalid size`, {
          details: { size: info.size, maxBytes },
        });
      }
      return await readFile(localPath);
    } finally {
      // This path is generated locally and never contains user input.
      await Promise.all([
        this.shell(serial, ["rm", remotePath], `${operation}_cleanup`).catch(() => undefined),
        rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  }

  private async sendFile(serial: string, localPath: string, remotePath: string, operation: string, signal?: AbortSignal): Promise<void> {
    validateSerial(serial);
    if (!/^\/data\/local\/tmp\/piora-[a-z]+-[0-9a-f-]+\.(?:txt|json|png)$/.test(remotePath)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid generated Harmony temporary path");
    }
    await this.run(["-t", serial, "file", "send", localPath, remotePath], operation, signal, 20_000);
  }

  private async dumpTree(serial: string, signal?: AbortSignal): Promise<{ tree: unknown; nodes: ReturnType<typeof flattenUiTree> }> {
    const remotePath = `/data/local/tmp/piora-layout-${randomUUID()}.json`;
    await this.shell(serial, ["uitest", "dumpLayout", "-p", remotePath], "dump_layout", signal);
    const data = await this.pullGeneratedFile(serial, remotePath, "layout", MAX_LAYOUT_BYTES, signal);
    try {
      const tree = JSON.parse(data.toString("utf8")) as unknown;
      return { tree, nodes: flattenUiTree(tree) };
    } catch (error) {
      throw new HarmonyError("INVALID_RESPONSE", "Harmony UiTest returned invalid layout JSON", { cause: error });
    }
  }

  private async captureScreen(serial: string, signal?: AbortSignal): Promise<HarmonyScreenshot> {
    let paths = this.liveScreenshotPaths.get(serial);
    if (!paths) {
      const directory = await mkdtemp(join(tmpdir(), "piora-harmony-live-"));
      paths = {
        directory,
        localPath: join(directory, "screen.png"),
        remotePath: `/data/local/tmp/piora-screen-${randomUUID()}.png`,
      };
      this.liveScreenshotPaths.set(serial, paths);
    }
    await rm(paths.localPath, { force: true }).catch(() => undefined);
    await this.shell(serial, ["uitest", "screenCap", "-p", paths.remotePath], "screen_capture", signal);
    await this.run(["-t", serial, "file", "recv", paths.remotePath, paths.localPath], "screenshot_pull", signal, 20_000);
    const info = await stat(paths.localPath);
    if (info.size <= 0 || info.size > MAX_SCREENSHOT_BYTES) {
      throw new HarmonyError("INVALID_RESPONSE", "Harmony screenshot file has an invalid size", {
        details: { size: info.size, maxBytes: MAX_SCREENSHOT_BYTES },
      });
    }
    return parsePng(await readFile(paths.localPath));
  }

  async startRecording(serial: string, remoteName: string, signal?: AbortSignal): Promise<void> {
    validateSerial(serial);
    if (!/^piora-recording-[0-9A-Za-z-]{8,96}\.mp4$/.test(remoteName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony recording name");
    }
    await this.shell(serial, [
      "aa", "start",
      "-b", "com.huawei.hmos.screenrecorder",
      "-a", "com.huawei.hmos.screenrecorder.ServiceExtAbility",
      "--ps", "CustomizedFileName", remoteName,
    ], "start_recording", signal, 20_000);
  }

  async stopRecording(serial: string, remoteName: string, destinationPath: string, signal?: AbortSignal): Promise<number> {
    validateSerial(serial);
    if (!/^piora-recording-[0-9A-Za-z-]{8,96}\.mp4$/.test(remoteName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony recording name");
    }
    await this.shell(serial, [
      "aa", "start",
      "-b", "com.huawei.hmos.screenrecorder",
      "-a", "com.huawei.hmos.screenrecorder.ServiceExtAbility",
    ], "stop_recording", signal, 20_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));

    const query = cleanOutput((await this.shell(serial, ["mediatool", "query", remoteName, "-u"], "query_recording", signal, 20_000)).stdout) ?? "";
    const mediaUri = query.match(/file:\/\/media\/[A-Za-z0-9._/%-]+/u)?.[0];
    let remotePath = query.match(/\/[A-Za-z0-9._/-]+\.mp4/u)?.[0];
    if (mediaUri) {
      const received = cleanOutput((await this.shell(
        serial,
        ["mediatool", "recv", mediaUri, "/data/local/tmp"],
        "prepare_recording_download",
        signal,
        20_000,
      )).stdout) ?? "";
      remotePath = received.match(/\/data\/local\/tmp\/[A-Za-z0-9._/-]+\.mp4/u)?.[0] ?? remotePath;
    }
    if (!remotePath || !/^\/[A-Za-z0-9._/-]+\.mp4$/.test(remotePath)) {
      throw new HarmonyError("INVALID_RESPONSE", "Harmony did not return a downloadable recording path", {
        details: { remoteName },
      });
    }
    await this.run(["-t", serial, "file", "recv", remotePath, destinationPath], "recording_pull", signal, 120_000);
    const info = await stat(destinationPath);
    if (remotePath.startsWith("/data/local/tmp/")) {
      await this.shell(serial, ["rm", remotePath], "recording_cleanup").catch(() => undefined);
    }
    return info.size;
  }

  private bundledMirrorServerPath(): string {
    const toolsDirectory = process.env.PIORA_HARMONY_TOOLS_DIR?.trim();
    const serverPath = toolsDirectory
      ? join(toolsDirectory, "OHScrcpyServer.hap")
      : join(process.cwd(), "third_party", "harmony-tools", `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`, "OHScrcpyServer.hap");
    if (!serverPath || !existsSync(serverPath)) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The bundled Harmony video service is missing from this Piora installation");
    }
    return serverPath;
  }

  private async ensureMirrorServer(serial: string, signal?: AbortSignal): Promise<void> {
    if (!this.preparedMirrorServers.has(serial)) {
      let installed = false;
      try {
        const result = await this.shell(serial, ["bm", "dump", "-n", MIRROR_BUNDLE], "mirror_server_check", signal, 8_000);
        const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
        installed = output.includes(MIRROR_BUNDLE) && !/(?:not\s+exist|not\s+found|failed)/i.test(output);
      } catch (error) {
        if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
      }
      if (!installed) {
        const result = await this.run(
          ["-t", serial, "install", "-r", this.bundledMirrorServerPath()],
          "mirror_server_install",
          signal,
          90_000,
        );
        const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
        if (/(?:install\s+fail|failure\[|permission denied)/i.test(output)) {
          throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device rejected the bundled Harmony video service", {
            details: { reason: "signature-or-screen-capture-permission" },
          });
        }
      }
      this.preparedMirrorServers.add(serial);
    }
    await this.shell(
      serial,
      ["aa", "start", "-b", MIRROR_BUNDLE, "-a", MIRROR_ABILITY],
      "mirror_server_start",
      signal,
      20_000,
    );
  }

  private async createMirrorForward(serial: string, signal?: AbortSignal): Promise<number> {
    try {
      const result = await this.run(
        ["-t", serial, "fport", "tcp:0", `tcp:${MIRROR_DEVICE_PORT}`],
        "mirror_forward",
        signal,
        8_000,
      );
      const port = parseHarmonyForwardedPort(Buffer.concat([result.stdout, result.stderr]).toString("utf8"));
      if (port) return port;
    } catch (error) {
      if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = await reserveLoopbackPort();
      try {
        await this.run(
          ["-t", serial, "fport", `tcp:${port}`, `tcp:${MIRROR_DEVICE_PORT}`],
          "mirror_forward",
          signal,
          8_000,
        );
        return port;
      } catch (error) {
        if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
      }
    }
    throw new HarmonyError("COMMAND_FAILED", "Unable to establish the Harmony video port forwarding", { retryable: true });
  }

  async openVideoStream(serial: string, signal?: AbortSignal): Promise<HarmonyVideoConnection> {
    validateSerial(serial);
    await this.ensureMirrorServer(serial, signal);
    const localPort = await this.createMirrorForward(serial, signal);
    let socket: Socket | undefined;
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          socket = await connectLoopback(localPort, signal);
          break;
        } catch (error) {
          lastError = error;
          if (signal?.aborted) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
        }
      }
      if (!socket) throw lastError ?? new Error("Harmony video service is unavailable");
    } catch (error) {
      await this.run(
        ["-t", serial, "fport", "rm", `tcp:${localPort}`, `tcp:${MIRROR_DEVICE_PORT}`],
        "mirror_forward_cleanup",
      ).catch(() => undefined);
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Unable to connect to the Harmony video service", {
        cause: error,
        retryable: true,
      });
    }

    const videoSocket = socket;
    videoSocket.write(encodeMirrorVideoParameters());
    const heartbeat = setInterval(() => {
      if (!videoSocket.destroyed && videoSocket.writable) videoSocket.write(encodeMirrorHeartbeat());
    }, 2_000);
    heartbeat.unref?.();

    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      videoSocket.removeAllListeners();
      videoSocket.destroy();
      await this.run(
        ["-t", serial, "fport", "rm", `tcp:${localPort}`, `tcp:${MIRROR_DEVICE_PORT}`],
        "mirror_forward_cleanup",
      ).catch(() => undefined);
    };
    const abort = () => {
      try { controller?.close(); } catch { /* The response stream may already be closed. */ }
      void close();
    };
    signal?.addEventListener("abort", abort, { once: true });

    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        videoSocket.on("data", (chunk: Buffer) => {
          if (closed) return;
          streamController.enqueue(Uint8Array.from(chunk));
          if ((streamController.desiredSize ?? 1) <= 0) videoSocket.pause();
        });
        videoSocket.once("end", () => {
          if (!closed) streamController.close();
          void close();
        });
        videoSocket.once("error", (error) => {
          if (!closed) streamController.error(error);
          void close();
        });
        videoSocket.once("close", () => {
          if (!closed) streamController.close();
          void close();
        });
      },
      pull() {
        if (!closed) videoSocket.resume();
      },
      async cancel() {
        await close();
      },
    });
    return { stream, close };
  }

  async dispose(): Promise<void> {
    const entries = [...this.liveScreenshotPaths.entries()];
    this.liveScreenshotPaths.clear();
    this.preparedMirrorServers.clear();
    await Promise.all(entries.flatMap(([serial, paths]) => [
      this.shell(serial, ["rm", paths.remotePath], "screenshot_cleanup").catch(() => undefined),
      rm(paths.directory, { recursive: true, force: true }).catch(() => undefined),
    ]));
  }

  async snapshot(
    serial: string,
    options: { includeTree: boolean; includeScreenshot: boolean; signal?: AbortSignal },
  ): Promise<BackendSnapshot> {
    validateSerial(serial);
    if (!options.includeTree && !options.includeScreenshot) {
      throw new HarmonyError("INVALID_ARGUMENT", "Snapshot must include a UI tree or screenshot");
    }
    const known = this.capabilitiesBySerial.get(serial);
    if ((options.includeTree && known?.uiTree === false) || (options.includeScreenshot && known?.screenshot === false)) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest snapshot capability is unavailable on this device");
    }
    const snapshot: BackendSnapshot = {};
    // The manager serializes these operations. Sequential execution is more reliable on UiTest.
    if (options.includeTree) {
      const layout = await this.dumpTree(serial, options.signal);
      snapshot.tree = layout.tree;
      snapshot.nodes = layout.nodes;
    }
    if (options.includeScreenshot) snapshot.screenshot = await this.captureScreen(serial, options.signal);
    return snapshot;
  }

  async tap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (this.capabilitiesBySerial.get(serial)?.tap === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest tap injection is unavailable on this device");
    }
    await this.shell(serial, ["uitest", "uiInput", "click", String(validateCoordinate(x, "x")), String(validateCoordinate(y, "y"))], "tap", signal);
  }

  async doubleTap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (this.capabilitiesBySerial.get(serial)?.tap === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest double-tap injection is unavailable on this device");
    }
    await this.shell(serial, ["uitest", "uiInput", "doubleClick", String(validateCoordinate(x, "x")), String(validateCoordinate(y, "y"))], "double_tap", signal);
  }

  async longPress(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (this.capabilitiesBySerial.get(serial)?.tap === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest long-press injection is unavailable on this device");
    }
    await this.shell(serial, ["uitest", "uiInput", "longClick", String(validateCoordinate(x, "x")), String(validateCoordinate(y, "y"))], "long_press", signal);
  }

  async swipe(
    serial: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs = 500,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.capabilitiesBySerial.get(serial)?.swipe === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest swipe injection is unavailable on this device");
    }
    const values = [
      validateCoordinate(fromX, "fromX"), validateCoordinate(fromY, "fromY"),
      validateCoordinate(toX, "toX"), validateCoordinate(toY, "toY"),
    ];
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 30_000) {
      throw new HarmonyError("INVALID_ARGUMENT", "durationMs must be between 50 and 30000");
    }
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const velocity = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.shell(serial, ["uitest", "uiInput", "swipe", ...values.map(String), String(velocity)], "swipe", signal);
  }

  async drag(
    serial: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs = 800,
    signal?: AbortSignal,
  ): Promise<void> {
    const values = [
      validateCoordinate(fromX, "fromX"), validateCoordinate(fromY, "fromY"),
      validateCoordinate(toX, "toX"), validateCoordinate(toY, "toY"),
    ];
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 30_000) {
      throw new HarmonyError("INVALID_ARGUMENT", "durationMs must be between 50 and 30000");
    }
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const velocity = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.shell(serial, ["uitest", "uiInput", "drag", ...values.map(String), String(velocity)], "drag", signal);
  }

  async fling(
    serial: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs = 250,
    signal?: AbortSignal,
  ): Promise<void> {
    const values = [
      validateCoordinate(fromX, "fromX"), validateCoordinate(fromY, "fromY"),
      validateCoordinate(toX, "toX"), validateCoordinate(toY, "toY"),
    ];
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 30_000) {
      throw new HarmonyError("INVALID_ARGUMENT", "durationMs must be between 50 and 30000");
    }
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const velocity = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.shell(serial, ["uitest", "uiInput", "fling", ...values.map(String), String(velocity)], "fling", signal);
  }

  async inputText(serial: string, text: string, signal?: AbortSignal): Promise<void> {
    validateSerial(serial);
    let capabilities = this.capabilitiesBySerial.get(serial);
    if (!capabilities) {
      capabilities = capabilitiesForUiTest(await this.safeInfo(serial, ["uitest", "--version"], signal));
      this.capabilitiesBySerial.set(serial, capabilities);
    }
    if (!capabilities.inputText) {
      throw new HarmonyError(
        "CAPABILITY_UNAVAILABLE",
        "Safe coordinate-free text input requires Harmony UiTest 5.1.1.1 or newer",
      );
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new HarmonyError("INVALID_ARGUMENT", "Input text must not be empty");
    }
    if (text.includes("\0")) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony text input does not support NUL characters");
    }
    const data = Buffer.from(text, "utf8");
    if (data.length > MAX_INPUT_TEXT_BYTES) {
      throw new HarmonyError("INVALID_ARGUMENT", `Input text exceeds ${MAX_INPUT_TEXT_BYTES} UTF-8 bytes`);
    }

    const id = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "piora-harmony-input-"));
    const localPath = join(directory, "input.txt");
    const remotePath = `/data/local/tmp/piora-input-${id}.txt`;
    try {
      await writeFile(localPath, data, { mode: 0o600 });
      await this.sendFile(serial, localPath, remotePath, "input_text_send", signal);
      await this.shell(serial, ["chmod", "600", remotePath], "input_text_protect", signal);
      // HDC joins shell argv with spaces and has historically not escaped embedded quotes.
      // Keep this generated command in one argv with no literal spaces. IFS expansion creates
      // the fixed argument boundaries on-device. A sentinel preserves trailing newlines; the
      // user-controlled bytes remain file data inside a quoted variable and are never reparsed.
      const command = `v="$(cat\${IFS}${remotePath};printf\${IFS}x)";v="\${v%x}";uitest\${IFS}uiInput\${IFS}text\${IFS}"$v"`;
      await this.shell(serial, [command], "input_text", signal);
    } finally {
      await this.shell(serial, ["rm", remotePath], "input_text_cleanup").catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async pressKey(
    serial: string,
    key: "back" | "home" | "recents" | "enter",
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.capabilitiesBySerial.get(serial)?.keys === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest key injection is unavailable on this device");
    }
    const value = { back: "Back", home: "Home", recents: "2720", enter: "2054" }[key];
    if (!value) throw new HarmonyError("INVALID_ARGUMENT", "Unsupported key");
    await this.shell(serial, ["uitest", "uiInput", "keyEvent", value], "press_key", signal);
  }

  async launchApp(
    serial: string,
    bundleName: string,
    abilityName?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName) || (abilityName !== undefined && !APP_IDENTIFIER_PATTERN.test(abilityName))) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle or ability name");
    }
    const args = ["aa", "start", "-b", bundleName];
    if (abilityName) args.push("-a", abilityName);
    await this.shell(serial, args, "launch_app", signal);
  }

  async installPackage(serial: string, hapPathValue: string, replace = true, signal?: AbortSignal): Promise<void> {
    if (!isAbsolute(hapPathValue) || extname(hapPathValue).toLowerCase() !== ".hap") {
      throw new HarmonyError("INVALID_ARGUMENT", "A valid absolute HAP package path is required");
    }
    const hapPath = resolve(hapPathValue);
    let details;
    try { details = await stat(hapPath); } catch (error) {
      throw new HarmonyError("INVALID_ARGUMENT", "The HAP package does not exist", { cause: error });
    }
    if (!details.isFile() || details.size <= 0 || details.size > 2 * 1024 * 1024 * 1024) {
      throw new HarmonyError("INVALID_ARGUMENT", "The HAP package is invalid or exceeds the installation limit");
    }
    const result = await this.run(["-t", serial, "install", ...(replace ? ["-r"] : []), hapPath], "install_package", signal, 120_000);
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    if (/(?:install\s+fail|failure\[|permission denied)/i.test(output)) {
      throw new HarmonyError("COMMAND_FAILED", "Harmony package installation failed", { retryable: true, details: { operation: "install_package" } });
    }
  }

  async stopApp(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    await this.shell(serial, ["aa", "force-stop", bundleName], "stop_app", signal);
  }

  async clearAppData(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    await this.shell(serial, ["bm", "clean", "-d", "-n", bundleName], "clear_app_data", signal, 30_000);
  }

  async uninstallPackage(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    await this.run(["-t", serial, "uninstall", bundleName], "uninstall_package", signal, 120_000);
  }
}

export function createHdcBackend(options: HdcBackendOptions = {}): HdcBackend {
  try {
    return new HdcBackend(options);
  } catch (error) {
    if (isHarmonyError(error)) throw error;
    throw new HarmonyError("HDC_INVALID", "Unable to initialize HDC", { cause: error });
  }
}
