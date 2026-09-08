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
  hypiumDriver?: HypiumAutomationDriver;
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
  private readonly hypium: HypiumAutomationDriver;

  constructor(options: HybridHarmonyBackendOptions = {}) {
    this.hdc = options.hdcBackend ?? createHdcBackend(options);
    this.hdcPath = this.hdc.hdcPath;
    this.hypium = options.hypiumDriver ?? new HypiumAutomationDriver({ hdcPath: this.hdcPath });
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

  private async preferHypium(
    serial: string,
    operation: string,
    signal: AbortSignal | undefined,
    rpc: Parameters<HypiumAutomationDriver["tryRun"]>[3],
    fallback: () => Promise<void>,
  ): Promise<void> {
    const result = await this.hypium.tryRun(serial, operation, signal, rpc);
    if (!result.used) await fallback();
  }

  async tap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "tap", signal, async (driver) => await driver.click(x, y),
      async () => await this.hdc.tap(serial, x, y, signal));
  }

  async doubleTap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "double_tap", signal, async (driver) => await driver.doubleClick(x, y),
      async () => await this.hdc.doubleTap(serial, x, y, signal));
  }

  async longPress(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "long_press", signal, async (driver) => await driver.longClick(x, y),
      async () => await this.hdc.longPress(serial, x, y, signal));
  }

  async swipe(serial: string, fromX: number, fromY: number, toX: number, toY: number, durationMs = 500, signal?: AbortSignal): Promise<void> {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.preferHypium(serial, "swipe", signal, async (driver) => await driver.swipe(fromX, fromY, toX, toY, speed),
      async () => await this.hdc.swipe(serial, fromX, fromY, toX, toY, durationMs, signal));
  }

  async drag(serial: string, fromX: number, fromY: number, toX: number, toY: number, durationMs = 800, signal?: AbortSignal): Promise<void> {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.preferHypium(serial, "drag", signal, async (driver) => await driver.drag(fromX, fromY, toX, toY, speed),
      async () => await this.hdc.drag(serial, fromX, fromY, toX, toY, durationMs, signal));
  }

  async fling(serial: string, fromX: number, fromY: number, toX: number, toY: number, durationMs = 250, signal?: AbortSignal): Promise<void> {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(40_000, Math.round(distance / (durationMs / 1000))));
    await this.preferHypium(serial, "fling", signal, async (driver) => await driver.fling(fromX, fromY, toX, toY, 20, speed),
      async () => await this.hdc.fling(serial, fromX, fromY, toX, toY, durationMs, signal));
  }

  async inputText(serial: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "input_text", signal, async (driver, module) => {
      const component = driver.findComponent(module.BY.focused(true), 1_000);
      if (!await component.exist()) throw new HarmonyError("UI_TARGET_NOT_FOUND", "No focused input component was found", { retryable: true });
      await component.inputText(text);
    }, async () => await this.hdc.inputText(serial, text, signal));
  }

  async pressKey(serial: string, key: "back" | "home" | "recents" | "enter", signal?: AbortSignal): Promise<void> {
    await this.preferHypium(serial, "press_key", signal, async (driver, module) => {
      if (key === "back") await driver.pressBack();
      else if (key === "home") await driver.pressHome();
      else await driver.triggerKey(key === "recents" ? module.KeyCode.APPSELECT : module.KeyCode.ENTER);
    }, async () => await this.hdc.pressKey(serial, key, signal));
  }

  async launchApp(serial: string, bundleName: string, abilityName?: string, signal?: AbortSignal): Promise<void> {
    await this.hdc.launchApp(serial, bundleName, abilityName, signal);
  }

  async installPackage(serial: string, hapPath: string, replace = true, signal?: AbortSignal): Promise<void> {
    await this.hdc.installPackage(serial, hapPath, replace, signal);
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

  async waitForIdle(serial: string, idleMs: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!await this.hypium.waitForIdle(serial, idleMs, timeoutMs, signal)) await abortedDelay(idleMs, signal);
  }

  async semanticAction(serial: string, request: HarmonySemanticActionRequest, signal?: AbortSignal): Promise<HarmonySemanticActionResult> {
    return await this.hypium.semanticAction(serial, request, signal);
  }

  async resetAutomation(serial?: string): Promise<void> {
    await this.hypium.reset(serial);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.hypium.reset(), Promise.resolve(this.hdc.dispose())]);
  }
}

export function createHybridHarmonyBackend(options: HybridHarmonyBackendOptions = {}): HybridHarmonyBackend {
  return new HybridHarmonyBackend(options);
}
