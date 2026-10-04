import { existsSync } from "node:fs";
import { link, lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve, dirname, posix } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { type CommandExecutor, type CommandResult, runCommand } from "./command-runner";
import { HarmonyError, isHarmonyError } from "./errors";
import { isHdcChannelNotReadyResponse } from "./device-connection";
import { readHarmonyConfig, defaultHarmonyConfigPath, resolveHdcPath, type ResolveHdcOptions } from "./runtime";
import { parseUiObservation } from "./ui-tree";
import { parseDisplayGeometry, type NativeDisplayGeometry } from "./observation/geometry";
import { ForwardOwnershipStore } from "./runtime/forward-store";
import { startOwnedRecording } from "./media/owned-recording";
import { previewHapArtifact } from "./runtime/hap-preview";
import { prepareLocalMirrorHap } from "./runtime/mirror-signing";
import { streamHdcLines } from "./log-stream";
import { capabilitiesFromHelp } from "./capabilities/probes";
import { physicalKeyCode, type PhysicalKey } from "./input/key-catalog";
import { runBoundedHold } from "./input/bounded-hold";
import { focusedWindowId, windowBundle } from "./observation/window-scope";
import { parseApplicationLabels, parseBundleList, parseApplicationDetails, type HarmonyApplication } from "./observation/applications";
import { deviceFileListScript, deviceFileStatScript, parseDeviceFileListing, quoteDeviceShell, validateDeviceFilePath, validateWritableDeviceFilePath, type HarmonyFileScope } from "./device-files";
import { decodeDeviceText, encodeDeviceText, MAX_DEVICE_TEXT_BYTES, type DeviceTextEncoding, type DeviceTextReadEncoding, type WritableDeviceNewline } from "./device-text";
import { MAX_DEVICE_TRANSFER_BYTES, deviceTransferTimeoutMs } from "./device-transfer-limits";
import { assertUnredirectedPath } from "./runtime/path-safety";
import { validateTcpDeviceAddress } from "./tcp-device";
import { openHosScrcpyVideo } from "./hos-scrcpy";
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
const MIRROR_DEVICE_PORT = 53_535;
const MIRROR_MAX_SHORT_EDGE = 1_080;
const MIRROR_BITRATE = 6_000_000;
const MIRROR_FRAME_RATE = 30;

function installedMirrorMatches(
  preview: Awaited<ReturnType<typeof previewHapArtifact>>,
  installed: HarmonyApplication | undefined,
): boolean {
  return preview.versionCode !== undefined
    && preview.versionName !== undefined
    && installed?.bundleName === preview.bundleName
    && installed.versionCode === preview.versionCode
    && installed.versionName === preview.versionName
    && installed.abilities?.includes("EntryAbility") === true;
}

function mayMeanBundleIsAbsent(output: string): boolean {
  const normalized = output.replace(/\0/g, "").trim();
  return normalized === ""
    || /^error:\s*failed to get information and the parameters may be wrong\.?$/i.test(normalized);
}

/** The sandbox shell reparses its command and drops script quotes on some HDC versions.
 * ASCII transport preserves the original script without changing the app sandbox or writing a script file.
 */
function protectSandboxShell(args: readonly string[]): readonly string[] {
  if (args.length !== 6 || args[2] !== "shell" || args[3] !== "-b") return args;
  return [...args.slice(0, 5), `printf %s ${Buffer.from(args[5], "utf8").toString("base64")} | base64 -d | sh`];
}

/** HDC may exit zero even when bm/aa rejected the operation. Never publish raw command paths. */
function requireDeviceReply(result: CommandResult, success: RegExp, operation: string, description: string): void {
  const reply = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "")
    .split(/\r?\n/).map(line => operation === "install_package" || operation === "uninstall_package"
      ? line.replace(/^\s*\[Info\]\s*App (?:install|uninstall) path:[^\r\n]*?(?:,\s*|\s+)msg\s*:\s*/i, "") : line).join("\n");
  const failed = /\berror\s*:|\bfail(?:ed|ure)?\b|permission denied|\[(?:fail|error)\]/i.test(reply);
  const signatureRejected = operation === "install_package" && /fail(?:ed)? to verify (?:pkcs7|signature)|signature verification fail|invalid signature/i.test(reply);
  const deviceErrorCode = reply.match(/\b(?:error\s*code|code)\s*[:=]\s*(\d{1,12})\b/i)?.[1];
  if (operation === "launch_app" && deviceErrorCode === "10106102") {
    throw new HarmonyError("SCREEN_LOCKED", "Unlock the phone before launching the application", {
      details: { operation, dispatchState: "sent", reason: "app-launch-locked", deviceErrorCode },
    });
  }
  if (failed || !success.test(reply)) throw new HarmonyError(failed ? "COMMAND_FAILED" : "INVALID_RESPONSE",
    signatureRejected ? "The device rejected the HAP signature; use a package signed for this device"
      : failed ? `The device rejected ${description}` : `The device did not confirm ${description}`, {
      details: { operation, dispatchState: "sent", ...(signatureRejected ? { reason: "signature-rejected" } : {}),
        ...(deviceErrorCode ? { deviceErrorCode } : {}) },
    });
}

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
  forwardJournalDirectory?: string;
  prepareMirrorHap?: (serial: string, sourceHapPath: string, signal?: AbortSignal) => Promise<string>;
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

function parseDeviceLine(line: string): { serial: string; state: HarmonyDeviceConnectionState; transport: "usb" | "tcp" | "unknown"; transportEvidence: "hdc" | "endpoint" | "unavailable" } | undefined {
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
  const transport = /(?:^|\s)usb(?:\s|$)/i.test(status) ? "usb"
    : /(?:^|\s)(?:tcp|wifi|wi-fi)(?:\s|$)/i.test(status) ? "tcp"
      : /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(serial) ? "tcp" : "unknown";
  const transportEvidence = transport === "unknown" ? "unavailable"
    : /(?:^|\s)(?:usb|tcp|wifi|wi-fi)(?:\s|$)/i.test(status) ? "hdc" : "endpoint";
  return { serial, state, transport, transportEvidence };
}

function cleanOutput(output: Buffer): string | undefined {
  const value = output.toString("utf8").replace(/\0/g, "").trim();
  return value && !/^(unknown|null|undefined)$/i.test(value) ? value.slice(0, 512) : undefined;
}

export function parseHarmonyScreenLockState(output: string): "locked" | "unlocked" | "unknown" {
  const matches = [...output.matchAll(/^[ \t]*(?:\*[ \t]*)?screenLocked(?:[ \t]*[:=][ \t]*|[ \t]+)(true|false)\b/gim)];
  if (matches.length !== 1) return "unknown";
  return matches[0][1].toLowerCase() === "true" ? "locked" : "unlocked";
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
  private readonly prepareMirrorHap: (serial: string, sourceHapPath: string, signal?: AbortSignal) => Promise<string>;
  private readonly capabilitiesBySerial = new Map<string, HarmonyCapabilities>();
  private readonly deviceInfoBySerial = new Map<string, { device: Omit<BackendDevice, "state">; expiresAt: number }>();
  private readonly ownedRecordings = new Map<string, { name: string; recording: Awaited<ReturnType<typeof startOwnedRecording>> }>();
  private readonly recordingStarts = new Set<string>();
  private readonly liveScreenshotPaths = new Map<string, { directory: string; localPath: string; remotePath: string }>();
  private readonly screenshotTails = new Map<string, Promise<void>>();

  private readonly forwardStore?: ForwardOwnershipStore;
  private readonly forwards = new Map<number, ReturnType<ForwardOwnershipStore["create"]>>();
  private readonly videoClosers = new Set<() => Promise<void>>();
  private readonly videoPreference: import("./types").HarmonyConfig["video"];
  private hosRetryAt = 0;

  interruptedForwards(serial: string) { return this.forwardStore?.interrupted(serial) ?? []; }

  constructor(options: HdcBackendOptions = {}) {
    if (!options.execute || options.forwardJournalDirectory) this.forwardStore = new ForwardOwnershipStore(options.forwardJournalDirectory ?? join(dirname(defaultHarmonyConfigPath()), "harmony-forwards"));
    const config = readHarmonyConfig();
    this.videoPreference = options.resolve?.config?.video ?? config.video;
    const resolution = resolveHdcPath({
      ...options.resolve,
      explicitPath: options.hdcPath ?? options.resolve?.explicitPath,
      config: options.resolve?.config ?? config,
    });
    this.hdcPath = resolution.hdcPath;
    this.execute = options.execute ?? runCommand;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.prepareMirrorHap = options.prepareMirrorHap ?? (async (serial, sourceHapPath, signal) => {
      const result = await this.shell(serial, ["bm", "get", "--udid"], "mirror_device_identity", signal, 8_000);
      const udids = [...new Set(Buffer.concat([result.stdout, result.stderr]).toString("utf8")
        .match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi) ?? [])];
      if (udids.length !== 1) {
        throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The connected phone identity could not be verified for local DevEco signing", {
          details: { reason: "mirror-device-identity-unavailable", dispatchState: "not-sent" },
        });
      }
      return await prepareLocalMirrorHap({
        sourceHapPath,
        hdcPath: this.hdcPath,
        deviceUdid: udids[0],
        cacheDirectory: join(dirname(defaultHarmonyConfigPath()), "harmony-mirror-private"),
        signal,
      });
    });
  }

  private async run(args: readonly string[], operation: string, signal?: AbortSignal, timeoutMs?: number) {
    const result = await this.execute({
      executable: this.hdcPath,
      args: protectSandboxShell(args),
      timeoutMs: timeoutMs ?? this.commandTimeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      signal,
      operation,
    });
    // Several HDC releases print a failure marker but still exit with code 0.
    // Treat that protocol response as an error so taps and pulls cannot report
    // false success. An empty target list is the one expected bracketed status.
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
    const channelNotReady = args[0] === "-t" && isHdcChannelNotReadyResponse(output);
    if (channelNotReady) {
      this.deviceInfoBySerial.delete(args[1]); this.capabilitiesBySerial.delete(args[1]);
    }
    if (operation !== "list_devices" && operation !== "list_devices_legacy"
      && (channelNotReady || /(?:^|\r?\n)\s*\[(?:Fail|Error|E\d{3,})\]/i.test(output))) {
      throw new HarmonyError("COMMAND_FAILED", "HDC rejected the device command", {
        details: { operation, ...(channelNotReady ? { reason: "hdc-channel-not-ready" } : {}) },
        retryable: true,
      });
    }
    return result;
  }

  private async shell(serial: string, args: readonly string[], operation: string, signal?: AbortSignal, timeoutMs?: number) {
    validateSerial(serial);
    return await this.run(["-t", serial, "shell", ...args], operation, signal, timeoutMs);
  }

  private async safeInfo(serial: string, args: readonly string[], signal?: AbortSignal, onResponse?: (result: CommandResult, value: string) => void, onFailure?: (error: unknown) => void): Promise<string | undefined> {
    try {
      const result = await this.shell(serial, args, "device_info", signal);
      if (result.exitCode !== 0) return undefined;
      const value = cleanOutput(result.stdout);
      // Device shell utilities can print diagnostics and still exit with zero.
      // Those diagnostics are not device names, models, or versions.
      if (!value || /[\r\n]/.test(value)
        || /(?:not found|not exist|permission denied|invalid (?:argument|parameter)|unknown (?:command|option)|get .* fail|^error\b|^usage:|^\/.*(?:sh|shell):)/i.test(value)) return undefined;
      onResponse?.(result, value);
      return value;
    } catch (error) {
      if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
      onFailure?.(error);
      return undefined;
    }
  }

  async applications(serial: string, query = "", bundleName?: string, signal?: AbortSignal): Promise<HarmonyApplication[]> {
    if (query.length > 256 || (bundleName && !APP_IDENTIFIER_PATTERN.test(bundleName))) throw new HarmonyError("INVALID_ARGUMENT", "Invalid application search");
    if (bundleName) {
      const output = (await this.shell(serial, ["bm", "dump", "-n", bundleName], "application_abilities", signal)).stdout.toString("utf8");
      return [parseApplicationDetails(output, bundleName)];
    }
    let apps: HarmonyApplication[];
    try { apps = parseApplicationLabels((await this.shell(serial, ["bm", "dump", "-a", "-l"], "application_labels", signal)).stdout.toString("utf8")); }
    catch (error) {
      if (signal?.aborted) throw error;
      apps = parseBundleList((await this.shell(serial, ["bm", "dump", "-a"], "application_list", signal)).stdout.toString("utf8"));
    }
    const term = query.toLocaleLowerCase();
    return apps.filter(app => `${app.bundleName}\n${app.label ?? ""}`.toLocaleLowerCase().includes(term));
  }

  async listFiles(serial: string, scope: HarmonyFileScope, path: string, signal?: AbortSignal, offset = 0) {
    validateSerial(serial);
    const normalized = validateDeviceFilePath(scope, path);
    const args = ["-t", serial, "shell", ...(scope.kind === "sandbox" ? ["-b", scope.bundleName] : []), deviceFileListScript(normalized, offset)];
    const output = (await this.run(args, "list_device_files", signal, 20_000)).stdout;
    return parseDeviceFileListing(output, normalized);
  }

  async statFile(serial: string, scope: HarmonyFileScope, path: string, signal?: AbortSignal) {
    validateSerial(serial);
    const normalized = validateDeviceFilePath(scope, path);
    if (normalized === "/" || normalized === ".") {
      await this.listFiles(serial, scope, normalized, signal);
      return { path: normalized, name: normalized, kind: "directory" as const };
    }
    const args = ["-t", serial, "shell", ...(scope.kind === "sandbox" ? ["-b", scope.bundleName] : []), deviceFileStatScript(normalized)];
    const output = (await this.run(args, "stat_device_file", signal, 10_000)).stdout;
    const file = parseDeviceFileListing(output, posix.dirname(normalized)).files.find(item => item.path === normalized);
    if (!file) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The requested device path could not be verified");
    return file;
  }

  async isSqliteFile(serial: string, scope: HarmonyFileScope, path: string, signal?: AbortSignal): Promise<boolean> {
    validateSerial(serial);
    const normalized = validateDeviceFilePath(scope, path);
    const script = `f=${quoteDeviceShell(normalized)}; if [ ! -f "$f" ]; then printf '__PIORA_SQLITE_UNAVAILABLE__'; exit 0; fi; h=$(dd if="$f" bs=15 count=1 2>/dev/null); rc=$?; if [ "$rc" -ne 0 ]; then printf '__PIORA_SQLITE_UNAVAILABLE__'; elif [ "$h" = 'SQLite format 3' ]; then printf '__PIORA_SQLITE_YES__'; else printf '__PIORA_SQLITE_NO__'; fi`;
    const args = ["-t", serial, "shell", ...(scope.kind === "sandbox" ? ["-b", scope.bundleName] : []), script];
    const output = (await this.run(args, "inspect_device_file_signature", signal, 10_000)).stdout.toString("utf8").trim();
    if (output.endsWith("__PIORA_SQLITE_YES__")) return true;
    if (output.endsWith("__PIORA_SQLITE_NO__")) return false;
    throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Device could not verify the SQLite file signature");
  }

  async pullFile(serial: string, scope: HarmonyFileScope, path: string, destinationPath: string, signal?: AbortSignal) {
    validateSerial(serial);
    const remote = validateDeviceFilePath(scope, path);
    if (remote === "/" || remote === "." || !isAbsolute(destinationPath)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a device file and absolute local destination");
    const scopeArgs = scope.kind === "sandbox" ? ["-b", scope.bundleName] : [];
    const source = quoteDeviceShell(remote);
    const preflight = (await this.run(["-t", serial, "shell", ...scopeArgs,
      `f=${source}; if [ ! -f "$f" ] || [ -L "$f" ]; then printf '__PIORA_FILE_ERROR__'; else stat -c '%s' "$f"; fi`], "device_file_preflight", signal)).stdout.toString("utf8").trim();
    const size = Number(preflight);
    if (!/^\d+$/.test(preflight) || !Number.isSafeInteger(size) || size > MAX_DEVICE_TRANSFER_BYTES) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device file is unavailable or exceeds the 1 GiB download limit");
    }
    const target = resolve(destinationPath);
    const parent = await stat(dirname(target)).catch(() => undefined);
    if (!parent?.isDirectory()) throw new HarmonyError("INVALID_ARGUMENT", "The local destination directory does not exist");
    await assertUnredirectedPath(dirname(target));
    const temporaryDirectory = await mkdtemp(join(dirname(target), ".piora-harmony-download-"));
    const temporaryFile = join(temporaryDirectory, "download");
    try {
      await this.run(["-t", serial, "file", "recv", ...scopeArgs, remote, temporaryFile], "device_file_download", signal, deviceTransferTimeoutMs(size));
      const downloaded = await stat(temporaryFile).catch(() => undefined);
      if (!downloaded?.isFile() || downloaded.size !== size) throw new HarmonyError("INVALID_RESPONSE", "Downloaded device file size differs from the preflight result");
      if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device file download was cancelled");
      await assertUnredirectedPath(dirname(target));
      // Staging and destination share a volume, so hard-linking exposes only a complete file and never replaces a rival target.
      try { await link(temporaryFile, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarmonyError("INVALID_ARGUMENT", "The local destination already exists");
        throw error;
      }
      return { destinationPath: target, size };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async pushFile(serial: string, scope: HarmonyFileScope, sourcePath: string, path: string, overwrite: boolean, signal?: AbortSignal): Promise<void> {
    validateSerial(serial);
    const remote = validateWritableDeviceFilePath(scope, path);
    if (!isAbsolute(sourcePath)) throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute local upload file");
    const source = await lstat(sourcePath).catch(() => undefined);
    if (!source?.isFile() || source.isSymbolicLink() || source.size > MAX_DEVICE_TRANSFER_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Upload file is missing or exceeds 1 GiB");
    const scopeArgs = scope.kind === "sandbox" ? ["-b", scope.bundleName] : [];
    const quoted = quoteDeviceShell(remote);
    const staged = validateWritableDeviceFilePath(scope, `${remote}.piora-upload-${randomUUID()}.tmp`);
    const stagedQuoted = quoteDeviceShell(staged);
    const existing = (await this.run(["-t", serial, "shell", ...scopeArgs,
      `f=${quoted}; if [ -L "$f" ]; then printf '__PIORA_SYMLINK__'; elif [ -d "$f" ]; then printf '__PIORA_DIRECTORY__'; elif [ -e "$f" ]; then printf '__PIORA_EXISTS__'; else printf '__PIORA_MISSING__'; fi`], "device_upload_preflight", signal)).stdout.toString("utf8").trim();
    if (existing === "__PIORA_SYMLINK__") throw new HarmonyError("INVALID_ARGUMENT", "Upload target is a symbolic link");
    if (existing === "__PIORA_DIRECTORY__") throw new HarmonyError("INVALID_ARGUMENT", "Upload target is a directory");
    if (existing !== "__PIORA_EXISTS__" && existing !== "__PIORA_MISSING__") throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Could not determine whether the device file exists");
    if (existing === "__PIORA_EXISTS__" && !overwrite) throw new HarmonyError("INVALID_ARGUMENT", "The device file already exists; enable overwrite explicitly");
    let stagedMayExist = false;
    try {
      stagedMayExist = true;
      const transfer = await this.run(["-t", serial, "file", "send", ...scopeArgs, sourcePath, staged], "device_file_upload", signal, deviceTransferTimeoutMs(source.size));
      const output = Buffer.concat([transfer.stdout, transfer.stderr]).toString("utf8");
      if (!/FileTransfer finish/i.test(output)) throw new HarmonyError("INVALID_RESPONSE", "HDC did not confirm that the file transfer finished", { details: { dispatchState: "sent" } });
      const stagedSize = (await this.run(["-t", serial, "shell", ...scopeArgs,
        `t=${stagedQuoted}; if [ -L "$t" ] || [ ! -f "$t" ]; then printf '__PIORA_STAGE_ERROR__'; else stat -c '%s' "$t"; fi`], "device_upload_stage_verify", signal)).stdout.toString("utf8").trim();
      if (!/^\d+$/.test(stagedSize) || Number(stagedSize) !== source.size) {
        throw new HarmonyError("INVALID_RESPONSE", "Staged device upload size could not be verified", { details: { dispatchState: "sent" } });
      }
      const finalize = `f=${quoted}; t=${stagedQuoted}; if [ -L "$f" ] || [ -d "$f" ] || [ -L "$t" ] || [ ! -f "$t" ]; then printf '__PIORA_PATH_ERROR__'; `
        + `${overwrite ? "else" : "elif [ -e \"$f\" ]; then printf '__PIORA_EXISTS__'; else"} mv ${overwrite ? "-f" : "-n"} "$t" "$f"; `
        + `if [ -e "$t" ] || [ -L "$t" ] || [ ! -f "$f" ] || [ -L "$f" ]; then printf '__PIORA_MOVE_ERROR__'; else stat -c '%s' "$f"; fi; fi`;
      const actualText = (await this.run(["-t", serial, "shell", ...scopeArgs, finalize], "device_upload_finalize", signal)).stdout.toString("utf8").trim();
      if (actualText === "__PIORA_EXISTS__") throw new HarmonyError("STALE_SNAPSHOT", "Upload target appeared during transfer; nothing was overwritten", { details: { dispatchState: "sent" } });
      if (!/^\d+$/.test(actualText) || Number(actualText) !== source.size) {
        throw new HarmonyError("INVALID_RESPONSE", "Device upload could not be verified after staging", { details: { dispatchState: "sent" } });
      }
      stagedMayExist = false;
    } finally {
      if (stagedMayExist) await this.run(["-t", serial, "shell", ...scopeArgs,
        `t=${stagedQuoted}; if [ -f "$t" ] && [ ! -L "$t" ]; then rm "$t"; fi`], "device_upload_cleanup", undefined, 5_000).catch(() => undefined);
    }
  }

  private async fileShell(serial: string, scope: HarmonyFileScope, script: string, operation: string, signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    validateSerial(serial);
    return (await this.run(["-t", serial, "shell", ...(scope.kind === "sandbox" ? ["-b", scope.bundleName] : []), script], operation, signal, timeoutMs)).stdout.toString("utf8").trim();
  }

  async runShellCommand(serial: string, scope: HarmonyFileScope, command: string, signal?: AbortSignal) {
    validateSerial(serial);
    validateDeviceFilePath(scope, scope.kind === "sandbox" ? "data/storage/el2/base" : "/data/local/tmp");
    if (typeof command !== "string" || !command.trim() || command.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Enter a command of at most 8192 characters");
    }
    const marker = `__PIORA_COMMAND_${randomUUID().replaceAll("-", "")}__`;
    const script = `sh -c ${quoteDeviceShell(command)}; code=$?; printf '\\n${marker}%s\\n' "$code"`;
    const result = await this.execute({ executable: this.hdcPath,
      args: protectSandboxShell(["-t", serial, "shell", ...(scope.kind === "sandbox" ? ["-b", scope.bundleName] : []), script]),
      operation: "manual_device_command", signal, timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
    const stdout = result.stdout.toString("utf8");
    const at = stdout.lastIndexOf(marker);
    if (at < 0) throw new HarmonyError("INVALID_RESPONSE", "Device command completion could not be verified", { details: { dispatchState: "sent" } });
    const status = stdout.slice(at + marker.length).trim();
    if (!/^\d{1,3}$/.test(status)) throw new HarmonyError("INVALID_RESPONSE", "Device command exit status is invalid", { details: { dispatchState: "sent" } });
    return { stdout: stdout.slice(0, at).replace(/\n$/, ""), stderr: result.stderr.toString("utf8"), exitCode: Number(status), durationMs: result.durationMs };
  }

  private async fileKind(serial: string, scope: HarmonyFileScope, path: string, signal?: AbortSignal): Promise<"file" | "directory" | "symlink" | "missing"> {
    const quoted = quoteDeviceShell(path);
    const result = await this.fileShell(serial, scope, `p=${quoted}; if [ -L "$p" ]; then printf '__PIORA_SYMLINK__'; elif [ -d "$p" ]; then printf '__PIORA_DIRECTORY__'; elif [ -f "$p" ]; then printf '__PIORA_FILE__'; elif [ -e "$p" ]; then printf '__PIORA_OTHER__'; else printf '__PIORA_MISSING__'; fi`, "device_file_kind", signal);
    const known = { __PIORA_FILE__: "file", __PIORA_DIRECTORY__: "directory", __PIORA_SYMLINK__: "symlink", __PIORA_MISSING__: "missing" } as const;
    if (!Object.hasOwn(known, result)) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Could not verify the device file type");
    return known[result as keyof typeof known];
  }

  async createDirectory(serial: string, scope: HarmonyFileScope, path: string, signal?: AbortSignal): Promise<void> {
    const remote = validateWritableDeviceFilePath(scope, path);
    if (await this.fileKind(serial, scope, remote, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "Device path already exists");
    await this.fileShell(serial, scope, `mkdir ${quoteDeviceShell(remote)}`, "device_mkdir", signal);
    if (await this.fileKind(serial, scope, remote, signal) !== "directory") {
      throw new HarmonyError("INVALID_RESPONSE", "Device directory creation could not be verified", { details: { dispatchState: "sent" } });
    }
  }

  async deletePath(serial: string, scope: HarmonyFileScope, path: string, signal?: AbortSignal): Promise<void> {
    const remote = validateWritableDeviceFilePath(scope, path);
    const kind = await this.fileKind(serial, scope, remote, signal);
    if (kind !== "file" && kind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Only a regular file or empty directory can be deleted");
    await this.fileShell(serial, scope, `${kind === "directory" ? "rmdir" : "rm"} ${quoteDeviceShell(remote)}`, "device_delete_path", signal);
    if (await this.fileKind(serial, scope, remote, signal) !== "missing") {
      throw new HarmonyError("INVALID_RESPONSE", "Device deletion could not be verified", { details: { dispatchState: "sent" } });
    }
  }

  async renamePath(serial: string, scope: HarmonyFileScope, path: string, newPath: string, signal?: AbortSignal): Promise<void> {
    const source = validateWritableDeviceFilePath(scope, path), target = validateWritableDeviceFilePath(scope, newPath);
    if (source === target || posix.dirname(source) !== posix.dirname(target)) throw new HarmonyError("INVALID_ARGUMENT", "Rename must use a new name in the same directory");
    const kind = await this.fileKind(serial, scope, source, signal);
    if (kind !== "file" && kind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Only a regular file or directory can be renamed");
    if (await this.fileKind(serial, scope, target, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "The target name already exists");
    await this.fileShell(serial, scope, `mv -n ${quoteDeviceShell(source)} ${quoteDeviceShell(target)}`, "device_rename_path", signal);
    if (await this.fileKind(serial, scope, source, signal) !== "missing" || await this.fileKind(serial, scope, target, signal) !== kind) {
      throw new HarmonyError("INVALID_RESPONSE", "Device rename could not be verified", { details: { dispatchState: "sent" } });
    }
  }

  async copyPath(serial: string, scope: HarmonyFileScope, path: string, newPath: string, move: boolean, signal?: AbortSignal): Promise<void> {
    const source = move ? validateWritableDeviceFilePath(scope, path) : validateDeviceFilePath(scope, path);
    const target = validateWritableDeviceFilePath(scope, newPath);
    if (source === target) throw new HarmonyError("INVALID_ARGUMENT", "Choose a different destination path");
    const sourceKind = await this.fileKind(serial, scope, source, signal);
    if (sourceKind !== "file" && sourceKind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Copy and move require a regular file or directory");
    if (sourceKind === "directory" && target.startsWith(`${source}/`)) throw new HarmonyError("INVALID_ARGUMENT", "A directory cannot be copied or moved into itself");
    if (await this.fileKind(serial, scope, target, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "The destination already exists");
    if (await this.fileKind(serial, scope, posix.dirname(target), signal) !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "The destination directory does not exist");
    if (sourceKind === "directory") {
      const inspection = await this.fileShell(serial, scope,
        `set -o pipefail; p=${quoteDeviceShell(source)}; bad=$(find "$p" ! -type d ! -type f -print -quit 2>/dev/null) || exit 2; if [ -n "$bad" ]; then printf '__PIORA_UNSUPPORTED_ENTRY__'; else find "$p" -print | wc -l; fi`,
        "device_copy_tree_inspection", signal, 30_000);
      if (inspection === "__PIORA_UNSUPPORTED_ENTRY__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Directory contains a symlink or special file; copy it separately after review");
      const entries = Number(inspection);
      if (!/^\d+$/.test(inspection) || !Number.isSafeInteger(entries) || entries > 10_000) {
        throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Directory copy is limited to 10000 entries");
      }
    }
    const sizeText = await this.fileShell(serial, scope, sourceKind === "file"
      ? `stat -c '%s' ${quoteDeviceShell(source)}` : `du -sb ${quoteDeviceShell(source)}`, "device_copy_size", signal, 30_000);
    const sizeMatch = sourceKind === "file" ? /^(\d+)$/.exec(sizeText) : /^(\d+)\s/.exec(sizeText);
    const size = sizeMatch ? Number(sizeMatch[1]) : Number.NaN;
    if (!Number.isSafeInteger(size) || size > 1024 * 1024 * 1024) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device copy and move are limited to at most 1 GiB");
    }
    const timeoutMs = size > 256 * 1024 * 1024 ? 30 * 60_000 : Math.max(30_000, this.commandTimeoutMs);
    const digest = async (candidate: string, digestSignal?: AbortSignal) => {
      const script = sourceKind === "file" ? `sha256sum ${quoteDeviceShell(candidate)}`
        : `set -o pipefail; p=${quoteDeviceShell(candidate)}; bad=$(find "$p" ! -type d ! -type f -print -quit 2>/dev/null) || exit 2; if [ -n "$bad" ]; then printf '__PIORA_UNSUPPORTED_ENTRY__'; else tar -C "$p" -cf - -s --mtime @0 --owner 0 --group 0 . | sha256sum; fi`;
      const output = await this.fileShell(serial, scope, script, "device_copy_hash", digestSignal, timeoutMs);
      if (output === "__PIORA_UNSUPPORTED_ENTRY__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Directory contains a symlink or special file; copy it separately after review");
      const match = /^([a-f0-9]{64})\s/i.exec(output);
      if (!match) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device tar and sha256sum are required to verify the copied content");
      return match[1].toLowerCase();
    };
    const originalHash = await digest(source, signal);
    const staged = `${target}.piora-copy-${randomUUID()}`;
    validateWritableDeviceFilePath(scope, staged);
    let stagedMayExist = false;
    try {
      if (await this.fileKind(serial, scope, staged, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "Temporary destination already exists");
      stagedMayExist = true;
      const copied = await this.fileShell(serial, scope,
        `cp ${sourceKind === "directory" ? "-R " : ""}${quoteDeviceShell(source)} ${quoteDeviceShell(staged)} && printf '__PIORA_COPIED__'`, "device_copy_path", signal, timeoutMs);
      if (copied !== "__PIORA_COPIED__") throw new HarmonyError("INVALID_RESPONSE", "Device copy did not confirm completion", { details: { dispatchState: "sent" } });
      if (await this.fileKind(serial, scope, staged, signal) !== sourceKind
        || await digest(source, signal) !== originalHash || await digest(staged, signal) !== originalHash) {
        throw new HarmonyError("STALE_SNAPSHOT", "Source changed during copy or destination content differs; no destination was published");
      }
      const published = await this.fileShell(serial, scope,
        `d=${quoteDeviceShell(target)}; s=${quoteDeviceShell(staged)}; if [ -e "$d" ] || [ -L "$d" ]; then printf '__PIORA_EXISTS__'; elif mv -n "$s" "$d"; then printf '__PIORA_PUBLISHED__'; fi`,
        "device_copy_publish", signal, timeoutMs);
      if (published === "__PIORA_EXISTS__") throw new HarmonyError("INVALID_ARGUMENT", "The destination appeared while copying; it was not overwritten");
      if (published !== "__PIORA_PUBLISHED__" || await this.fileKind(serial, scope, staged, signal) !== "missing"
        || await this.fileKind(serial, scope, target, signal) !== sourceKind || await digest(target, signal) !== originalHash) {
        throw new HarmonyError("INVALID_RESPONSE", "Device copy result could not be verified", { details: { dispatchState: "sent" } });
      }
      if (move && sourceKind === "directory") {
        const heldSource = `${source}.piora-move-${randomUUID()}`;
        validateWritableDeviceFilePath(scope, heldSource);
        if (await this.fileKind(serial, scope, heldSource, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "Temporary source path already exists");
        if (await digest(source, signal) !== originalHash) throw new HarmonyError("STALE_SNAPSHOT", "Source changed before moving; verified destination remains as a copy");
        const held = await this.fileShell(serial, scope,
          `s=${quoteDeviceShell(source)}; h=${quoteDeviceShell(heldSource)}; if [ -e "$h" ] || [ -L "$h" ]; then printf '__PIORA_EXISTS__'; elif mv -n "$s" "$h"; then printf '__PIORA_HELD__'; fi`,
          "device_move_hold_source", signal, timeoutMs);
        if (held !== "__PIORA_HELD__" || await this.fileKind(serial, scope, source, signal) !== "missing"
          || await this.fileKind(serial, scope, heldSource, signal) !== "directory") {
          throw new HarmonyError("INVALID_RESPONSE", "Directory move could not safely isolate its source; inspect the source and destination", { details: { dispatchState: "sent" } });
        }
        if (await digest(heldSource, signal) !== originalHash) {
          await this.fileShell(serial, scope,
            `s=${quoteDeviceShell(source)}; h=${quoteDeviceShell(heldSource)}; if [ ! -e "$s" ] && [ ! -L "$s" ]; then mv -n "$h" "$s"; fi`,
            "device_move_restore_source", undefined, timeoutMs).catch(() => undefined);
          throw new HarmonyError("STALE_SNAPSHOT", "Directory changed during move; verified destination remains as a copy; inspect the source before retrying");
        }
        const removed = await this.fileShell(serial, scope,
          `h=${quoteDeviceShell(heldSource)}; rm -r "$h" && printf '__PIORA_REMOVED__'`, "device_move_remove_source", signal, timeoutMs);
        if (removed !== "__PIORA_REMOVED__" || await this.fileKind(serial, scope, heldSource, signal) !== "missing"
          || await digest(target, signal) !== originalHash) {
          throw new HarmonyError("INVALID_RESPONSE", "Destination is verified but source cleanup is incomplete; inspect both directories", { details: { dispatchState: "sent" } });
        }
      } else if (move) {
        const removed = await this.fileShell(serial, scope,
          `s=${quoteDeviceShell(source)}; h=$(sha256sum "$s" 2>/dev/null); case "$h" in ${originalHash}' '*) rm "$s" && printf '__PIORA_REMOVED__';; *) printf '__PIORA_CHANGED__';; esac`,
          "device_move_remove_source", signal, timeoutMs);
        if (removed === "__PIORA_CHANGED__") throw new HarmonyError("STALE_SNAPSHOT", "Source changed before removal; verified destination remains as a copy");
        if (removed !== "__PIORA_REMOVED__" || await this.fileKind(serial, scope, source, signal) !== "missing"
          || await digest(target, signal) !== originalHash) {
          throw new HarmonyError("INVALID_RESPONSE", "Destination was copied, but source removal could not be verified; inspect both paths", { details: { dispatchState: "sent" } });
        }
      }
    } finally {
      if (stagedMayExist) await this.fileShell(serial, scope,
        `s=${quoteDeviceShell(staged)}; if [ -d "$s" ] && [ ! -L "$s" ]; then rm -r "$s"; elif [ -f "$s" ] && [ ! -L "$s" ]; then rm "$s"; fi`,
        "device_copy_cleanup", undefined, 10_000).catch(() => undefined);
    }
  }

  async chmodPath(serial: string, scope: HarmonyFileScope, path: string, mode: string, signal?: AbortSignal): Promise<void> {
    const remote = validateWritableDeviceFilePath(scope, path);
    if (typeof mode !== "string" || !/^[0-7]{3}$/.test(mode)) throw new HarmonyError("INVALID_ARGUMENT", "Permissions must use three octal digits");
    const kind = await this.fileKind(serial, scope, remote, signal);
    if (kind !== "file" && kind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Only regular files and directories can change permissions");
    const quoted = quoteDeviceShell(remote);
    const result = await this.fileShell(serial, scope,
      `p=${quoted}; if [ -L "$p" ] || { [ ! -f "$p" ] && [ ! -d "$p" ]; }; then printf '__PIORA_FILE_ERROR__'; else chmod ${mode} "$p" && stat -c '%a' "$p"; fi`,
      "device_chmod", signal);
    if (!/^[0-7]{3,4}$/.test(result) || Number.parseInt(result, 8) !== Number.parseInt(mode, 8)) {
      throw new HarmonyError("INVALID_RESPONSE", "Device file permissions could not be verified", { details: { dispatchState: "sent" } });
    }
  }

  async readTextFile(serial: string, scope: HarmonyFileScope, path: string, signal?: AbortSignal, encoding: DeviceTextReadEncoding = "auto") {
    const remote = validateDeviceFilePath(scope, path);
    if (await this.fileKind(serial, scope, remote, signal) !== "file") throw new HarmonyError("INVALID_ARGUMENT", "Choose a regular device text file");
    const sizeText = await this.fileShell(serial, scope, `stat -c '%s' ${quoteDeviceShell(remote)}`, "device_text_size", signal);
    const size = Number(sizeText);
    if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size > MAX_DEVICE_TEXT_BYTES) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Text preview is limited to 2 MiB files");
    }
    const directory = await mkdtemp(join(tmpdir(), "piora-harmony-text-"));
    const local = join(directory, "preview.txt");
    try {
      await this.pullFile(serial, scope, remote, local, signal);
      const bytes = await readFile(local);
      if (bytes.length !== size) throw new HarmonyError("INVALID_RESPONSE", "Device file is incomplete");
      return { ...decodeDeviceText(bytes, encoding), hash: createHash("sha256").update(bytes).digest("hex"), size };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async saveTextFile(serial: string, scope: HarmonyFileScope, path: string, text: string, expectedHash: string, signal?: AbortSignal, newlineMode?: WritableDeviceNewline, encoding?: DeviceTextEncoding): Promise<void> {
    const remote = validateWritableDeviceFilePath(scope, path);
    if (typeof text !== "string" || text.includes("\0") || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Text and the expected SHA-256 are required");
    }
    const requestedEncoding = encoding?.replace("-bom", "") as DeviceTextReadEncoding | undefined;
    const current = await this.readTextFile(serial, scope, remote, signal, requestedEncoding);
    if (current.hash !== expectedHash) throw new HarmonyError("STALE_SNAPSHOT", "The device file changed since it was opened; reload before saving");
    if (encoding && encoding !== current.encoding) throw new HarmonyError("STALE_SNAPSHOT", "Device text encoding changed; reload before saving");
    const bytes = encodeDeviceText(text, current.encoding ?? "utf-8", current.newline ?? "lf", newlineMode);
    const directory = await mkdtemp(join(tmpdir(), "piora-harmony-edit-"));
    const local = join(directory, "edit.txt");
    const staged = validateWritableDeviceFilePath(scope, `${remote}.piora-${randomUUID()}.tmp`);
    const newHash = createHash("sha256").update(bytes).digest("hex");
    let uploaded = false;
    try {
      await writeFile(local, bytes, { mode: 0o600 });
      await this.pushFile(serial, scope, local, staged, false, signal);
      uploaded = true;
      const target = quoteDeviceShell(remote), temporary = quoteDeviceShell(staged);
      const script = `p=${target}; t=${temporary}; if ! command -v sha256sum >/dev/null 2>&1; then printf '__PIORA_NO_HASH__'; elif [ -L "$p" ] || [ ! -f "$p" ] || [ ! -f "$t" ]; then printf '__PIORA_FILE_ERROR__'; else sum=$(sha256sum "$p" 2>/dev/null); case "$sum" in ${expectedHash}' '*) mv -f "$t" "$p" && printf '__PIORA_APPLIED__';; *) printf '__PIORA_STALE__';; esac; fi`;
      const result = await this.fileShell(serial, scope, script, "device_text_replace", signal);
      if (result === "__PIORA_STALE__") throw new HarmonyError("STALE_SNAPSHOT", "The device file changed during save; reload before retrying", { details: { dispatchState: "sent" } });
      if (result === "__PIORA_NO_HASH__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device sha256sum is required for safe text editing");
      if (result !== "__PIORA_APPLIED__") throw new HarmonyError("INVALID_RESPONSE", "Device text replacement could not be confirmed", { details: { dispatchState: "unknown" } });
      uploaded = false;
      if ((await this.readTextFile(serial, scope, remote, signal, requestedEncoding)).hash !== newHash) {
        throw new HarmonyError("INVALID_RESPONSE", "Saved device text failed content verification", { details: { dispatchState: "sent" } });
      }
    } finally {
      if (uploaded) await this.run(["-t", serial, "shell", ...(scope.kind === "sandbox" ? ["-b", scope.bundleName] : []),
        `t=${quoteDeviceShell(staged)}; if [ -f "$t" ] && [ ! -L "$t" ]; then rm "$t"; fi`], "device_edit_cleanup", undefined, 5_000).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async appTestAudio(serial: string, packet: string, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9+/=]{1,20000}$/.test(packet)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid debug PCM packet");
    await this.requireUnlockedScreen(serial, signal);
    await this.shell(serial, ["aa", "start", "-b", "dev.piora.audio.fixture", "-a", "EntryAbility", "--ps", "pioraPcmPacket", packet], "app_test_audio", signal);
  }

  async connectTcpDevice(address: string, remove: boolean, signal?: AbortSignal): Promise<void> {
    const endpoint = validateTcpDeviceAddress(address);
    const result = await this.run(remove ? ["tconn", endpoint, "-remove"] : ["tconn", endpoint], remove ? "tcp_disconnect" : "tcp_connect", signal, 15_000);
    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
    if (/\[fail\]|connect failed|disconnect failed/i.test(output)) throw new HarmonyError("COMMAND_FAILED", `HDC TCP ${remove ? "disconnect" : "connect"} failed: ${output.trim().slice(0, 300)}`);
    const listing = await this.run(["list", "targets"], "tcp_verify", signal, 8_000);
    const connected = listing.stdout.toString("utf8").split(/\r?\n/).some(line => {
      const device = parseDeviceLine(line);
      return device?.serial === endpoint && device.state === "online";
    });
    if (connected === remove) throw new HarmonyError("INVALID_RESPONSE", `HDC TCP ${remove ? "disconnect" : "connect"} could not be verified in the device list`);
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
      transport: "usb" | "tcp" | "unknown";
      transportEvidence: "hdc" | "endpoint" | "unavailable";
    }>;
    const unique = [...new Map(parsed.map((device) => [device.serial, device])).values()];
    const online = new Set(unique.filter((device) => device.state === "online").map((device) => device.serial));
    for (const serial of this.deviceInfoBySerial.keys()) {
      if (!online.has(serial)) {
        this.deviceInfoBySerial.delete(serial);
        this.capabilitiesBySerial.delete(serial);
      }
    }

    return await Promise.all(unique.map(async ({ serial, state, transport, transportEvidence }): Promise<BackendDevice> => {
      if (state !== "online") {
        return { serial, state, transport, transportEvidence, capabilities: { ...NO_UITEST_CAPABILITIES, launchApp: false } };
      }
      const cached = this.deviceInfoBySerial.get(serial);
      if (cached && cached.expiresAt > Date.now() && cached.device.transport === transport) return { ...cached.device, state, transport, transportEvidence };
      let responseSample: BackendDevice["responseSample"];
      let channelNotReady = false;
      const [model, product, userName, persistedName, deviceName, osVersion, apiVersion, uitestVersion] = await Promise.all([
        this.safeInfo(serial, ["param", "get", "const.product.model"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.name"], signal),
        this.safeInfo(serial, ["settings", "get", "secure", "unified_device_name"], signal),
        this.safeInfo(serial, ["param", "get", "persist.sys.device_name"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.devicename"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.software.version"], signal),
        this.safeInfo(serial, ["param", "get", "const.ohos.apiversion"], signal, (result, value) => {
          if (/^\d+$/.test(value) && Number.isFinite(result.durationMs) && result.durationMs >= 0 && result.durationMs <= 60_000) {
            responseSample = { durationMs: Math.round(result.durationMs), sampledAt: new Date().toISOString() };
          }
        }, error => { if (isHarmonyError(error) && error.details?.reason === "hdc-channel-not-ready") channelNotReady = true; }),
        this.safeInfo(serial, ["uitest", "--version"], signal),
      ]);
      // Missing parameters or denied optional utilities do not imply an offline
      // phone. Require an explicit channel error and no successful metadata read.
      if (channelNotReady && ![model, product, userName, persistedName, deviceName, osVersion, apiVersion, uitestVersion].some(Boolean)) {
        return { serial, state: "unknown", connectionIssue: "hdc-channel-not-ready", transport, transportEvidence,
          capabilities: { ...NO_UITEST_CAPABILITIES, launchApp: false } };
      }
      const capabilities = capabilitiesForUiTest(uitestVersion);
      this.capabilitiesBySerial.set(serial, capabilities);
      const deviceInfo: Omit<BackendDevice, "state"> = {
        serial,
        transport,
        transportEvidence,
        responseSample,
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

  async probeCapabilities(serial: string, signal?: AbortSignal) {
    const help = async (args: string[]) => {
      try { const result = await this.shell(serial, args, "capability_probe", signal, 8_000); return Buffer.concat([result.stdout, result.stderr]).toString("utf8").slice(0, 64 * 1024); }
      catch (error) { if (signal?.aborted) throw error; return undefined; }
    };
    const [uitest, input, uinput] = await Promise.all([
      help(["uitest", "help"]),
      help(["uitest", "uiInput", "help"]),
      help(["uinput", "--help"]),
    ]);
    return capabilitiesFromHelp({ uitest, input, uinput });
  }

  async doctorProbes(serial: string, signal?: AbortSignal) {
    const probe = async (args: string[], local = false) => {
      try { const result = local ? await this.run(args, "doctor_host_version", signal, 8000) : await this.shell(serial, args, "doctor_read_only", signal, 8000); return Buffer.concat([result.stdout, result.stderr]).toString("utf8").slice(0, 64 * 1024); }
      catch (error) { if (signal?.aborted) throw error; return ""; }
    };
    const [version, mirror, lock, install, uinput] = await Promise.all([
      probe(["-v"], true), probe(["bm", "dump", "-n", MIRROR_BUNDLE]),
      probe(["hidumper", "-s", "ScreenlockService", "-a", "-all"]), probe(["bm", "help"]), probe(["uinput", "--help"]),
    ]);
    const check = (name: string, known: boolean, reason: string) => ({ name, status: known ? "passed" as const : "unknown" as const, reason });
    return { hdcVersion: version.trim().split(/\r?\n/)[0]?.slice(0, 160), checks: [
      check("video-component", mirror.includes(MIRROR_BUNDLE) && !/not found|not exist|failed/i.test(mirror), "Package presence only; video connection and initialization are separate"),
      check("screen-unlocked", parseHarmonyScreenLockState(lock) === "unlocked", "Read-only lock inspection; unlock manually if required"),
      check("package-install-command", /\binstall\b/.test(install), "Help availability only; installation may still be denied by the device"),
      check("bounded-uinput-protocol", ["--down", "--up", "--interval"].every(token => uinput.includes(token)), "Help evidence only; physical key/touch behavior requires calibration"),
    ] };
  }

  private async requireHoldProtocol(serial: string, kind: "key" | "touch", signal?: AbortSignal) {
    const result = await this.shell(serial, ["uinput", "--help"], "hold_protocol_probe", signal, 8_000);
    const help = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    if (!help.includes(kind === "key" ? "--keyboard" : "--touch") || !["--down", "--up", "--interval"].every(token => help.includes(token))) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device does not advertise the required bounded down/interval/up protocol", { details: { dispatchState: "not-sent" } });
    }
  }

  async keyHold(serial: string, key: PhysicalKey, durationMs: number, signal?: AbortSignal) {
    await this.requireUnlockedScreen(serial, signal);
    await this.requireHoldProtocol(serial, "key", signal);
    const code = String(physicalKeyCode(key));
    return await runBoundedHold({ durationMs, minMs: 50, maxMs: key === "power" ? 3000 : 5000, signal,
      dispatch: async inner => { await this.shell(serial, ["uinput", "-K", "-d", code, "-i", String(durationMs), "-u", code], "key_hold", inner, durationMs + 5000); },
      release: async () => { await this.shell(serial, ["uinput", "-K", "-u", code], "key_hold_release", undefined, 3000); },
    });
  }

  async touchHold(serial: string, x: number, y: number, durationMs: number, signal?: AbortSignal) {
    if (![x,y].every(value => Number.isInteger(value) && value >= 0 && value < 16_384)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid touch coordinate");
    await this.requireUnlockedScreen(serial, signal);
    await this.requireHoldProtocol(serial, "touch", signal);
    return await runBoundedHold({ durationMs, minMs: 50, maxMs: 15_000, signal,
      dispatch: async inner => { await this.shell(serial, ["uinput", "-T", "-d", String(x), String(y), "-i", String(durationMs), "-u", String(x), String(y)], "touch_hold", inner, durationMs + 5000); },
      release: async () => { await this.shell(serial, ["uinput", "-T", "-u", String(x), String(y)], "touch_hold_release", undefined, 3000); },
    });
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

  private async dumpTree(serial: string, signal?: AbortSignal): Promise<BackendSnapshot> {
    const before = await this.activeWindow(serial, signal);
    const remotePath = `/data/local/tmp/piora-layout-${randomUUID()}.json`;
    await this.shell(serial, ["uitest", "dumpLayout", "-p", remotePath], "dump_layout", signal);
    const data = await this.pullGeneratedFile(serial, remotePath, "layout", MAX_LAYOUT_BYTES, signal);
    try {
      const tree = JSON.parse(data.toString("utf8")) as unknown;
      const observation = parseUiObservation(tree);
      const after = await this.activeWindow(serial, signal);
      if (before && after && before.windowId === after.windowId && before.appId === after.appId) {
        observation.quality = { ...observation.quality!, ...after };
      } else if (before || after) {
        observation.quality = { treeStatus: "partial", scopeComplete: false, scope: "unknown" };
      } else {
        observation.quality = { ...observation.quality!, scope: "unknown" };
      }
      return observation;
    } catch (error) {
      throw new HarmonyError("INVALID_RESPONSE", "Harmony UiTest returned invalid layout JSON", { cause: error });
    }
  }

  private async activeWindow(serial: string, signal?: AbortSignal): Promise<{ windowId: string; appId?: string } | undefined> {
    try {
      const windows = await this.shell(serial, ["hidumper", "-s", "WindowManagerService", "-a", "-a"], "focus_probe", signal, 5_000);
      const windowId = focusedWindowId(windows.stdout.toString("utf8"));
      if (!windowId) return undefined;
      const detail = await this.shell(serial, ["hidumper", "-s", "WindowManagerService", "-a", `-w ${windowId}`], "window_scope", signal, 5_000);
      return { windowId, appId: windowBundle(detail.stdout.toString("utf8"), windowId) };
    } catch (error) { if (signal?.aborted) throw error; return undefined; }
  }

  private async captureScreen(serial: string, signal?: AbortSignal): Promise<HarmonyScreenshot> {
    // Passive frame polling and a user screenshot share one HDC temporary path.
    // Serialize only that path, leaving video and device input free to continue.
    const previous = this.screenshotTails.get(serial) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.screenshotTails.set(serial, tail);
    try {
      await previous;
      if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Screenshot capture was cancelled");
      return await this.captureScreenNow(serial, signal);
    } finally {
      release();
      if (this.screenshotTails.get(serial) === tail) this.screenshotTails.delete(serial);
    }
  }

  private async captureScreenNow(serial: string, signal?: AbortSignal): Promise<HarmonyScreenshot> {
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
    try {
      await this.shell(serial, ["uitest", "screenCap", "-p", paths.remotePath], "screen_capture", signal);
      await this.run(["-t", serial, "file", "recv", paths.remotePath, paths.localPath], "screenshot_pull", signal, 20_000);
      const info = await stat(paths.localPath);
      if (info.size <= 0 || info.size > MAX_SCREENSHOT_BYTES) {
        throw new HarmonyError("INVALID_RESPONSE", "Harmony screenshot file has an invalid size", {
          details: { size: info.size, maxBytes: MAX_SCREENSHOT_BYTES },
        });
      }
      return parsePng(await readFile(paths.localPath));
    } finally {
      // Keep cleanup inside the per-device capture queue, using its own bounded
      // command even after caller cancellation. Decoded bytes need no staging file.
      await Promise.allSettled([
        this.shell(serial, ["rm", "-f", paths.remotePath], "screenshot_cleanup", undefined, 3_000),
        rm(paths.localPath, { force: true }),
      ]);
    }
  }

  async startRecording(serial: string, remoteName: string, signal?: AbortSignal, onFailure?: (error: HarmonyError) => void): Promise<void> {
    validateSerial(serial);
    if (!/^piora-recording-[0-9A-Za-z-]{8,96}\.mp4$/.test(remoteName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony recording name");
    if (this.ownedRecordings.has(serial) || this.recordingStarts.has(serial)) throw new HarmonyError("DEVICE_BUSY", "This runtime already owns a recording on the device");
    this.recordingStarts.add(serial);
    let connection: HarmonyVideoConnection | undefined;
    try {
      connection = await this.openVideoStream(serial, signal);
      const recording = await startOwnedRecording(connection, signal, onFailure);
      this.ownedRecordings.set(serial, { name: remoteName, recording });
    } catch (error) {
      try { await connection?.close(); }
      catch (cause) { throw new HarmonyError("DEVICE_BUSY", "Recording startup forward cleanup is uncertain", { cause, details: { recordingStopped: true, cleanup: "uncertain" } }); }
      throw new HarmonyError(isHarmonyError(error) ? error.code : "COMMAND_FAILED", error instanceof Error ? error.message : "Recording startup failed", { cause: error, details: { ...(isHarmonyError(error) ? error.details : {}), recordingStopped: true, dispatchState: "not-sent" } });
    }
    finally { this.recordingStarts.delete(serial); }
  }

  async stopRecording(serial: string, remoteName: string, destinationPath: string, signal?: AbortSignal): Promise<number> {
    void signal; // Stopping an owned read subscription must finish even after caller cancellation.
    validateSerial(serial);
    const owned = this.ownedRecordings.get(serial);
    if (!owned || owned.name !== remoteName) throw new HarmonyError("INVALID_ARGUMENT", "No recording owned by this runtime matches the requested operation");
    try { return await owned.recording.stop(destinationPath); }
    catch (error) { throw new HarmonyError(isHarmonyError(error) ? error.code : "COMMAND_FAILED", error instanceof Error ? error.message : "Owned recording failed", { cause: error, details: { ...(isHarmonyError(error) ? error.details : {}), recordingStopped: true } }); }
    finally { this.ownedRecordings.delete(serial); }
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

  mirrorPackagePath(): string { return this.bundledMirrorServerPath(); }

  async displayGeometry(serial: string, signal?: AbortSignal): Promise<NativeDisplayGeometry> {
    const result = await this.shell(serial, ["hidumper", "-s", "DisplayManagerService", "-a", "-a"], "display_geometry", signal, 8_000);
    const geometry = parseDisplayGeometry(result.stdout.toString("utf8"));
    if (!geometry) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Native input geometry is unknown or has multiple displays; coordinate control is disabled");
    return geometry;
  }

  private async requireUnlockedScreen(serial: string, signal?: AbortSignal): Promise<void> {
    const result = await this.shell(serial, ["hidumper", "-s", "ScreenlockService", "-a", "-all"], "screen_lock_state", signal, 8_000);
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    const lockState = parseHarmonyScreenLockState(output);
    if (lockState !== "unlocked") {
      throw new HarmonyError("SCREEN_LOCKED", "Unlock the phone yourself before starting screen mirroring; Piora never wakes or unlocks it automatically", {
        details: { reason: lockState === "locked" ? "locked" : "lock-state-unknown" },
      });
    }
  }

  private async observeMirrorInstallation(
    serial: string,
    signal?: AbortSignal,
    reason = "mirror-installation-state-unavailable",
    dispatchState: "not-sent" | "sent" = "not-sent",
  ): Promise<HarmonyApplication | undefined> {
    const unavailable = (cause: unknown) => new HarmonyError(
      "OBSERVATION_UNAVAILABLE",
      reason === "mirror-uninstallation-unverified"
        ? "The previous capture component removal could not be verified"
        : "The capture component installation state could not be verified",
      { cause, details: { reason, dispatchState } },
    );
    let exactOutput: string;
    try {
      const result = await this.shell(serial, ["bm", "dump", "-n", MIRROR_BUNDLE], "mirror_installation_state", signal, 8_000);
      exactOutput = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    } catch (cause) {
      if (signal?.aborted || isHarmonyError(cause) && cause.code === "COMMAND_ABORTED") throw cause;
      throw unavailable(cause);
    }
    try {
      return parseApplicationDetails(exactOutput, MIRROR_BUNDLE);
    } catch (cause) {
      if (!mayMeanBundleIsAbsent(exactOutput)) throw unavailable(cause);
    }

    try {
      const result = await this.shell(serial, ["bm", "dump", "-a"], "mirror_installation_absence", signal, 8_000);
      const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
      if (/(?:^|\r?\n)\s*(?:error\b|fail(?:ed|ure)?\b|permission denied)/i.test(output)) {
        throw new Error("bundle list contains a failure response");
      }
      const applications = parseBundleList(output);
      if (applications.some(application => application.bundleName === MIRROR_BUNDLE)) {
        throw new Error("exact bundle lookup disagrees with the installed bundle list");
      }
      return undefined;
    } catch (cause) {
      if (signal?.aborted || isHarmonyError(cause) && cause.code === "COMMAND_ABORTED") throw cause;
      throw unavailable(cause);
    }
  }

  private async previewMirrorHap(path: string, signal?: AbortSignal) {
    try {
      return await previewHapArtifact(path, signal);
    } catch (cause) {
      if (signal?.aborted || cause instanceof DOMException && cause.name === "AbortError") {
        throw new HarmonyError("COMMAND_ABORTED", "Harmony video component initialization was cancelled", {
          cause,
          retryable: true,
          details: { reason: "mirror-initialization-cancelled", dispatchState: "not-sent" },
        });
      }
      throw cause;
    }
  }

  private async ensureMirrorServer(serial: string, signal?: AbortSignal): Promise<void> {
    const result = await this.shell(serial, ["bm", "dump", "-n", MIRROR_BUNDLE], "mirror_server_check", signal, 8_000);
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
    if (!output.includes(MIRROR_BUNDLE) || /(?:not\s+exist|not\s+found|failed)/i.test(output)) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Initialize the phone video component in the Harmony workbench; passive viewing never installs it", { details: { reason: "mirror-component-missing" } });
    }
    await this.requireUnlockedScreen(serial, signal);
  }

  async initializeMirror(serial: string, hapPath: string, signal?: AbortSignal): Promise<void> {
    validateSerial(serial);
    await this.requireUnlockedScreen(serial, signal);
    const sourcePreview = await this.previewMirrorHap(hapPath, signal);
    if (sourcePreview.bundleName !== MIRROR_BUNDLE || !sourcePreview.abilities.includes("EntryAbility")
      || sourcePreview.versionCode === undefined || sourcePreview.versionName === undefined) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The capture package has no supported foreground entry", { details: { reason: "mirror-package-invalid", dispatchState: "not-sent" } });
    }
    let installed = await this.observeMirrorInstallation(serial, signal);

    if (installedMirrorMatches(sourcePreview, installed)) {
      await this.launchApp(serial, MIRROR_BUNDLE, "EntryAbility", signal);
      return;
    }

    const privateHapPath = await this.prepareMirrorHap(serial, hapPath, signal);
    const preview = await this.previewMirrorHap(privateHapPath, signal);
    if (preview.bundleName !== sourcePreview.bundleName || preview.versionCode !== sourcePreview.versionCode
      || preview.versionName !== sourcePreview.versionName || preview.moduleName !== sourcePreview.moduleName
      || !preview.abilities.includes("EntryAbility")) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The private capture package differs from the bundled component", {
        details: { reason: "mirror-private-package-invalid", dispatchState: "not-sent" },
      });
    }

    if (!installedMirrorMatches(preview, installed)) {
      if (installed) {
        await this.uninstallPackage(serial, MIRROR_BUNDLE, signal);
        const remaining = await this.observeMirrorInstallation(
          serial,
          signal,
          "mirror-uninstallation-unverified",
          "sent",
        );
        if (remaining) {
          throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The previous capture component is still installed", {
            details: { reason: "mirror-uninstallation-unverified", dispatchState: "sent" },
          });
        }
      }
      await this.installPackage(serial, privateHapPath, false, signal);
      installed = await this.observeMirrorInstallation(serial, signal, "mirror-installation-unverified", "sent");
    }
    if (!installedMirrorMatches(preview, installed)) {
      throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The installed capture component could not be verified", { details: { reason: "mirror-installation-unverified", dispatchState: "sent" } });
    }
    await this.launchApp(serial, MIRROR_BUNDLE, "EntryAbility", signal);
  }

  private async createMirrorForward(serial: string, signal?: AbortSignal): Promise<number> {
    const port = await reserveLoopbackPort();
    const record = this.forwardStore?.create(serial, port, MIRROR_DEVICE_PORT);
    if (record) this.forwards.set(port, record);
    // Record the exact intended port before dispatch. An ambiguous failure is never retried.
    await this.run(["-t", serial, "fport", `tcp:${port}`, `tcp:${MIRROR_DEVICE_PORT}`], "mirror_forward", signal, 8_000);
    if (record) { record.state = "established"; this.forwardStore!.save(record); }
    return port;
  }

  private async removeMirrorForward(serial: string, port: number) {
    try {
      await this.run(["-t", serial, "fport", "rm", `tcp:${port}`, `tcp:${MIRROR_DEVICE_PORT}`], "mirror_forward_cleanup", undefined, 1500);
      const record = this.forwards.get(port);
      if (record) { this.forwardStore!.clear(record); this.forwards.delete(port); }
    } catch (cause) { throw new HarmonyError("DEVICE_BUSY", "Owned video forward cleanup is uncertain; inspect the exact forward in device diagnostics", { cause, details: { cleanup: "uncertain", localPort: port, remotePort: MIRROR_DEVICE_PORT } }); }
  }

  async openVideoStream(serial: string, signal?: AbortSignal): Promise<HarmonyVideoConnection> {
    if (this.videoPreference?.provider === "hos-scrcpy" && this.videoPreference.packageDirectory && Date.now() >= this.hosRetryAt) {
      try {
        await this.requireUnlockedScreen(serial, signal);
        const connection = await openHosScrcpyVideo({ serial, hdcPath: this.hdcPath,
          packageDirectory: this.videoPreference.packageDirectory, javaPath: this.videoPreference.javaPath, signal,
          onFailure: () => { this.hosRetryAt = Date.now() + 60_000; } });
        this.videoClosers.add(connection.close);
        return { stream: connection.stream, close: async () => { try { await connection.close(); } finally { this.videoClosers.delete(connection.close); } } };
      } catch (error) {
        if (signal?.aborted) throw error;
        this.hosRetryAt = Date.now() + 60_000;
      }
    }
    return this.openBundledVideoStream(serial, signal);
  }

  private async openBundledVideoStream(serial: string, signal?: AbortSignal): Promise<HarmonyVideoConnection> {
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
      if (signal?.aborted) {
        socket.destroy();
        throw new Error("Harmony video connection was cancelled");
      }
    } catch (error) {
      await this.removeMirrorForward(serial, localPort);
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Unable to connect to the Harmony video service", {
        cause: error,
        retryable: true,
      });
    }

    const videoSocket = socket;
    videoSocket.write(encodeMirrorVideoParameters());
    // A new subscriber needs an IDR from the already-consented encoder.
    videoSocket.write(encodeMirrorPacket(0x10, Buffer.from([0x43])));
    const heartbeat = setInterval(() => {
      if (!videoSocket.destroyed && videoSocket.writable) videoSocket.write(encodeMirrorHeartbeat());
    }, 2_000);
    heartbeat.unref?.();

    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      closed = true;
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      videoSocket.removeAllListeners();
      videoSocket.destroy();
      try { await this.removeMirrorForward(serial, localPort); }
      finally { this.videoClosers.delete(close); }
    })();
    this.videoClosers.add(close);
    const abort = () => {
      try { controller?.close(); } catch { /* The response stream may already be closed. */ }
      void close().catch(() => undefined);
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
          void close().catch(() => undefined);
        });
        videoSocket.once("error", (error) => {
          if (!closed) streamController.error(error);
          void close().catch(() => undefined);
        });
        videoSocket.once("close", () => {
          if (!closed) streamController.close();
          void close().catch(() => undefined);
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
    const cleanup = await Promise.allSettled([...this.videoClosers].map(close => close()));
    await Promise.all([...this.ownedRecordings.values()].map(owned => owned.recording.discard()));
    this.ownedRecordings.clear();
    const entries = [...this.liveScreenshotPaths.entries()];
    this.liveScreenshotPaths.clear();
    await Promise.all(entries.flatMap(([serial, paths]) => [
      this.shell(serial, ["rm", paths.remotePath], "screenshot_cleanup").catch(() => undefined),
      rm(paths.directory, { recursive: true, force: true }).catch(() => undefined),
    ]));
    if (cleanup.some(result => result.status === "rejected")) throw new HarmonyError("DEVICE_BUSY", "Video forward cleanup remains uncertain", { details: { cleanup: "uncertain" } });
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
      snapshot.quality = layout.quality;
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
    const result = await this.shell(serial, args, "launch_app", signal);
    requireDeviceReply(result, /^\s*start ability successfully\.?\s*$/im, "launch_app", "starting the application");
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
    requireDeviceReply(result, /^\s*install bundle successfully\.?\s*$/im, "install_package", "installing the package");
  }

  async stopApp(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    await this.shell(serial, ["aa", "force-stop", bundleName], "stop_app", signal);
  }

  async clearAppData(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const result = await this.shell(serial, ["bm", "clean", "-d", "-n", bundleName], "clear_app_data", signal, 30_000);
    requireDeviceReply(result, /^\s*clean bundle data files successfully\.?\s*$/im, "clear_app_data", "clearing the app data");
  }

  async clearAppCache(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const result = await this.shell(serial, ["bm", "clean", "-c", "-n", bundleName], "clear_app_cache", signal, 30_000);
    requireDeviceReply(result, /^\s*clean bundle cache files successfully\.?\s*$/im, "clear_app_cache", "clearing the app cache");
  }

  async uninstallPackage(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const result = await this.run(["-t", serial, "uninstall", bundleName], "uninstall_package", signal, 120_000);
    requireDeviceReply(result, /^\s*uninstall bundle successfully\.?\s*$/im, "uninstall_package", "uninstalling the package");
  }

  async setAppEnabled(serial: string, bundleName: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const operation = enabled ? "enable_app" : "disable_app";
    let result;
    try { result = await this.shell(serial, ["bm", enabled ? "enable" : "disable", "-n", bundleName], operation, signal); }
    catch (error) {
      if (!isHarmonyError(error) || error.code !== "COMMAND_FAILED") throw error;
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "bm enable/disable was refused; this operation requires a root device build", { cause: error, details: { dispatchState: "sent" } });
    }
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    if (!new RegExp(`${enabled ? "enable" : "disable"} bundle successfully`, "i").test(output)) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device did not confirm the app state change; bm enable/disable requires a root build", { details: { dispatchState: "sent" } });
    }
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
