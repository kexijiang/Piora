import { HypiumWorkerClient } from "./runtime/worker-client";
import { HarmonyError } from "./errors";
import { createHdcBackend, type HdcBackend, type HdcBackendOptions } from "./hdc-backend";
import { HypiumAutomationDriver, type HypiumAutomationStatus } from "./hypium-backend";
import type {
  BackendDevice,
  BackendSnapshot,
  HarmonyAutomationBackend,
  HarmonyLogEntry,
  HarmonyLogLevel,
  HarmonyProcess,
  HarmonySemanticActionRequest,
  HarmonySemanticActionResult,
  HarmonyVideoConnection,
} from "./types";

export interface HybridHarmonyBackendOptions extends HdcBackendOptions {
  hdcBackend?: HdcBackend;
  hypiumDriver?: Pick<HypiumAutomationDriver, "execute" | "semanticAction" | "waitForIdle" | "status" | "invalidate" | "reset">;
}

function abortedDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Keeps the proven HDC video/file/runtime implementation intact while routing
 * UI input through a persistent Hypium RPC agent whenever it is available.
 */
export class HybridHarmonyBackend implements HarmonyAutomationBackend {
  readonly kind = "hdc-uitest+hypium";
  readonly hdcPath: string;
  private readonly hdc: HdcBackend;
  private readonly hypium: NonNullable<HybridHarmonyBackendOptions["hypiumDriver"]>;

  constructor(options: HybridHarmonyBackendOptions = {}) {
    this.hdc = options.hdcBackend ?? createHdcBackend(options);
    this.hdcPath = this.hdc.hdcPath;
    this.hypium = options.hypiumDriver ?? new HypiumWorkerClient(this.hdcPath);
  }

  automationStatus(): HypiumAutomationStatus[] {
    return this.hypium.status();
  }

  automationDiagnostics() {
    return { provider: "hypium", sessions: this.automationStatus() };
  }

  async listDevices(signal?: AbortSignal): Promise<BackendDevice[]> {
    const devices = await this.hdc.listDevices(signal);
    await Promise.all(devices.filter((device) => device.state !== "online").map(async (device) => await this.hypium.invalidate(device.serial)));
    return devices;
  }

  async listProcesses(serial: string, signal?: AbortSignal): Promise<HarmonyProcess[]> {
    return await this.hdc.listProcesses(serial, signal);
  }

  async doctorProbes(serial: string, signal?: AbortSignal) { return this.hdc.doctorProbes(serial, signal); }

  interruptedForwards(serial: string) { return this.hdc.interruptedForwards(serial); }

  async probeCapabilities(serial: string, signal?: AbortSignal) { return await this.hdc.probeCapabilities(serial, signal); }
  async applications(...args: Parameters<HdcBackend["applications"]>) { return await this.hdc.applications(...args); }
  async appTestAudio(...args: Parameters<HdcBackend["appTestAudio"]>) { return await this.hdc.appTestAudio(...args); }
  async keyHold(...args: Parameters<HdcBackend["keyHold"]>) { return await this.hdc.keyHold(...args); }
  async touchHold(...args: Parameters<HdcBackend["touchHold"]>) { return await this.hdc.touchHold(...args); }

  async streamLogs(serial: string, onEntries: (entries: HarmonyLogEntry[]) => void, signal?: AbortSignal): Promise<void> {
    await this.hdc.streamLogs(serial, onEntries, signal);
  }

  async readLogs(serial: string, options: { pid?: number; level?: Exclude<HarmonyLogLevel, "unknown">; query?: string; limit?: number; signal?: AbortSignal }): Promise<HarmonyLogEntry[]> {
    return await this.hdc.readLogs(serial, options);
  }

  async snapshot(serial: string, options: { includeTree: boolean; includeScreenshot: boolean; signal?: AbortSignal }): Promise<BackendSnapshot> {
    return await this.hdc.snapshot(serial, options);
  }

  async startRecording(serial: string, remoteName: string, signal?: AbortSignal): Promise<void> {
    await this.hdc.startRecording(serial, remoteName, signal);
  }

  async stopRecording(serial: string, remoteName: string, destinationPath: string, signal?: AbortSignal): Promise<number> {
    return await this.hdc.stopRecording(serial, remoteName, destinationPath, signal);
  }

  async openVideoStream(serial: string, signal?: AbortSignal): Promise<HarmonyVideoConnection> {
    return await this.hdc.openVideoStream(serial, signal);
  }

  mirrorPackagePath(): string { return this.hdc.mirrorPackagePath(); }

  async displayGeometry(serial: string, signal?: AbortSignal) { return await this.hdc.displayGeometry(serial, signal); }

  async initializeMirror(serial: string, hapPath: string, signal?: AbortSignal): Promise<void> {
    await this.hdc.initializeMirror(serial, hapPath, signal);
  }

  private async preferHypium(
    serial: string,
    operation: string,
    signal: AbortSignal | undefined,
    args: unknown[],
    fallback: () => Promise<void>,
  ): Promise<void> {
    const result = await this.hypium.execute(serial, operation, args, signal);
    if (!result.used) await fallback();
  }

  async tap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "tap", signal, [x, y],
      async () => await this.hdc.tap(serial, x, y, signal));
  }

  async doubleTap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "double_tap", signal, [x, y],
      async () => await this.hdc.doubleTap(serial, x, y, signal));
  }

  async longPress(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "long_press", signal, [x, y],
      async () => await this.hdc.longPress(serial, x, y, signal));
  }

  async swipe(serial: string, fromX: number, fromY: number, toX: number, toY: number, durationMs = 500, signal?: AbortSignal): Promise<void> {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.preferHypium(serial, "swipe", signal, [fromX, fromY, toX, toY, speed],
      async () => await this.hdc.swipe(serial, fromX, fromY, toX, toY, durationMs, signal));
  }

  async drag(serial: string, fromX: number, fromY: number, toX: number, toY: number, durationMs = 800, signal?: AbortSignal): Promise<void> {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.preferHypium(serial, "drag", signal, [fromX, fromY, toX, toY, speed],
      async () => await this.hdc.drag(serial, fromX, fromY, toX, toY, durationMs, signal));
  }

  async fling(serial: string, fromX: number, fromY: number, toX: number, toY: number, durationMs = 250, signal?: AbortSignal): Promise<void> {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.preferHypium(serial, "fling", signal, [fromX, fromY, toX, toY, speed],
      async () => await this.hdc.fling(serial, fromX, fromY, toX, toY, durationMs, signal));
  }

  async inputText(serial: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "input_text", signal, [text], async () => {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Exact text input requires semantic readback", { details: { dispatchState: "not-sent" } });
    });
  }

  async pressKey(serial: string, key: "back" | "home" | "recents" | "enter", signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "press_key", signal, [key], async () => await this.hdc.pressKey(serial, key, signal));
  }

  async launchApp(serial: string, bundleName: string, abilityName?: string, signal?: AbortSignal): Promise<void> {
    await this.hdc.launchApp(serial, bundleName, abilityName, signal);
  }

  async installPackage(serial: string, hapPath: string, replace = true, signal?: AbortSignal): Promise<void> {
    await this.hdc.installPackage(serial, hapPath, replace, signal);
  }

  async listFiles(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, signal?: AbortSignal) {
    return await this.hdc.listFiles(serial, scope, path, signal);
  }

  async pullFile(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, destinationPath: string, signal?: AbortSignal) {
    return await this.hdc.pullFile(serial, scope, path, destinationPath, signal);
  }

  async pushFile(serial: string, scope: import("./device-files").HarmonyFileScope, sourcePath: string, path: string, overwrite: boolean, signal?: AbortSignal) {
    await this.hdc.pushFile(serial, scope, sourcePath, path, overwrite, signal);
  }

  async createDirectory(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, signal?: AbortSignal) {
    await this.hdc.createDirectory(serial, scope, path, signal);
  }

  async deletePath(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, signal?: AbortSignal) {
    await this.hdc.deletePath(serial, scope, path, signal);
  }

  async renamePath(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, newPath: string, signal?: AbortSignal) {
    await this.hdc.renamePath(serial, scope, path, newPath, signal);
  }

  async readTextFile(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, signal?: AbortSignal) {
    return await this.hdc.readTextFile(serial, scope, path, signal);
  }

  async saveTextFile(serial: string, scope: import("./device-files").HarmonyFileScope, path: string, text: string, expectedHash: string, signal?: AbortSignal) {
    await this.hdc.saveTextFile(serial, scope, path, text, expectedHash, signal);
  }

  async runShellCommand(serial: string, scope: import("./device-files").HarmonyFileScope, command: string, signal?: AbortSignal) {
    return await this.hdc.runShellCommand(serial, scope, command, signal);
  }

  async stopApp(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    await this.hdc.stopApp(serial, bundleName, signal);
  }

  async clearAppData(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    await this.hdc.clearAppData(serial, bundleName, signal);
  }

  async uninstallPackage(serial: string, bundleName: string, signal?: AbortSignal): Promise<void> {
    await this.hdc.uninstallPackage(serial, bundleName, signal);
  }

  async waitForIdle(serial: string, idleMs: number, timeoutMs: number, signal?: AbortSignal): Promise<{ strategy: "driver_idle" | "bounded_delay" }> {
    if (await this.hypium.waitForIdle(serial, idleMs, timeoutMs, signal)) return { strategy: "driver_idle" };
    await abortedDelay(idleMs, signal);
    return { strategy: "bounded_delay" };
  }

  async semanticAction(serial: string, request: HarmonySemanticActionRequest, signal?: AbortSignal): Promise<HarmonySemanticActionResult> {
    return await this.hypium.semanticAction(serial, request, signal);
  }

  async resetAutomation(serial?: string): Promise<void> {
    await this.hypium.reset(serial);
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([this.hypium.reset(), Promise.resolve(this.hdc.dispose())]);
    if (results.some(result => result.status === "rejected")) throw new HarmonyError("DEVICE_BUSY", "Harmony provider cleanup is uncertain", { details: { cleanup: "uncertain" } });
  }
}

export function createHybridHarmonyBackend(options: HybridHarmonyBackendOptions = {}): HybridHarmonyBackend {
  return new HybridHarmonyBackend(options);
}
