import { physicalKeyCode } from "./input/key-catalog";
import { openGestureConnection, type GestureConnection } from "./input/gesture-connection";
import { LiveTouch } from "./input/live-touch";
import { allocatePioraPort, configureHypiumPorts } from "./runtime/local-port";
import { mkdirSync, readFileSync } from "node:fs";
import { getRuntimeUserHomeDirectory as homedir } from "../runtime-home";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";

import { writePrivateFileAtomicSync } from "../atomic-file";
import { HarmonyError } from "./errors";
import { validateHarmonySelector } from "./selector";
import type {
  HarmonySemanticActionRequest,
  HarmonySemanticActionResult,
  HarmonyUiSelector,
} from "./types";

type HypiumModule = typeof import("hypium-driver");
type HypiumDriver = Awaited<ReturnType<HypiumModule["UiDriver"]["connect"]>>;
type HypiumBy = ReturnType<HypiumModule["BY"]["text"]>;
type HypiumComponent = ReturnType<HypiumDriver["findComponent"]>;

const CONNECT_TIMEOUT_MS = 20_000;
const DRIVER_COOLDOWN_MS = 30_000;

export interface HypiumAutomationDriverOptions {
  hdcPath: string;
  importDriver?: () => Promise<HypiumModule>;
  now?: () => number;
  preparePrivacy?: () => void;
  openGesture?: (driver: HypiumDriver, module: HypiumModule) => Promise<GestureConnection>;
}

export interface HypiumAutomationStatus {
  serial: string;
  state: "idle" | "connecting" | "ready" | "cooldown";
  retryAt?: string;
}

export function disableHypiumTelemetry(directory = join(homedir(), ".hypium")): void {
  const path = join(directory, ".hypium_driver_config");
  try {
    mkdirSync(directory, { recursive: true });
    const release = lockSync(path, { realpath: false });
    try {
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid Hypium settings");
      if (settings.telemetry !== false) writePrivateFileAtomicSync(path, `${JSON.stringify({ ...settings, telemetry: false })}\n`);
    } finally { release(); }
  } catch (error) {
    throw new HarmonyError(
      "AUTOMATION_DRIVER_UNAVAILABLE",
      "Hypium telemetry could not be disabled, so Piora refused to start the third-party driver",
      { cause: error, retryable: true, details: { dispatchState: "not-sent" } },
    );
  }
}

function timeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", message, { retryable: true })), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function matchPattern(module: HypiumModule, selector: HarmonyUiSelector): import("hypium-driver").MatchPattern {
  if (selector.match === "contains") return module.MatchPattern.CONTAINS;
  if (selector.match === "starts_with") return module.MatchPattern.STARTS_WITH;
  if (selector.match === "ends_with") return module.MatchPattern.ENDS_WITH;
  return module.MatchPattern.EQUALS;
}

function selectorBy(module: HypiumModule, selector: HarmonyUiSelector): HypiumBy {
  validateHarmonySelector(selector);
  if (selector.description !== undefined || selector.visible !== undefined) {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This selector requires Piora's layout fallback instead of Hypium semantic lookup", { details: { dispatchState: "not-sent" } });
  }
  const pattern = matchPattern(module, selector);
  let by: HypiumBy | undefined;
  const extend = (next: (source: HypiumBy) => HypiumBy, seed: () => HypiumBy): void => {
    by = by ? next(by) : seed();
  };
  if (selector.id) extend((source) => source.id(selector.id!, pattern), () => module.BY.id(selector.id!, pattern));
  if (selector.text) extend((source) => source.text(selector.text!, pattern), () => module.BY.text(selector.text!, pattern));
  if (selector.type) extend((source) => source.type(selector.type!, pattern), () => module.BY.type(selector.type!, pattern));
  if (selector.hint) extend((source) => source.hint(selector.hint!, pattern), () => module.BY.hint(selector.hint!, pattern));
  if (selector.inWindow) extend((source) => source.inWindow(selector.inWindow!), () => module.BY.inWindow(selector.inWindow!));
  for (const key of ["clickable", "scrollable", "enabled", "focused", "selected", "checked"] as const) {
    const value = selector[key];
    if (value === undefined) continue;
    extend((source) => source[key](value), () => module.BY[key](value));
  }
  if (!by) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Hypium requires a supported semantic selector field", { details: { dispatchState: "not-sent" } });
  if (selector.within) by = by.within(selectorBy(module, selector.within));
  if (selector.before) by = by.isBefore(selectorBy(module, selector.before));
  if (selector.after) by = by.isAfter(selectorBy(module, selector.after));
  return by;
}

async function resolveSemanticComponent(
  driver: HypiumDriver,
  module: HypiumModule,
  selector: HarmonyUiSelector,
  timeoutMs: number,
): Promise<HypiumComponent> {
  const by = selectorBy(module, selector);
  const awaited = driver.findComponent(by, timeoutMs);
  if (!await awaited.exist()) {
    throw new HarmonyError("UI_TARGET_NOT_FOUND", "No UI element matched the requested selector", { retryable: true });
  }
  const matches = await driver.findComponents(by);
  if (selector.index !== undefined) {
    const indexed = matches[selector.index];
    if (!indexed) {
      throw new HarmonyError("UI_TARGET_NOT_FOUND", "The requested UI selector index was not found", {
        details: { matchCount: matches.length, requestedIndex: selector.index }, retryable: true,
      });
    }
    return indexed;
  }
  if (matches.length > 1) {
    throw new HarmonyError("UI_TARGET_AMBIGUOUS", "The UI selector matched more than one element; add a stable id, relationship, or index", {
      details: { matchCount: matches.length }, retryable: true,
    });
  }
  return matches[0] ?? awaited;
}

async function focusedTextComponent(driver: HypiumDriver, module: HypiumModule): Promise<HypiumComponent> {
  // Harmony reports focus on every ancestor of the focused input, including
  // Web/Stack/Navigation. Only an editable field is an unambiguous text target.
  const fields: HypiumComponent[] = [];
  // Filter on the phone: querying each focused ancestor adds many RPCs, and
  // the UiTest RPC transport must not receive overlapping property requests.
  for (const type of ["TextInput", "TextArea", "textField", "RichEditor"]) {
    fields.push(...await driver.findComponents(module.BY.focused(true).type(type)));
  }
  if (fields.length !== 1) throw new HarmonyError(fields.length ? "UI_TARGET_AMBIGUOUS" : "UI_TARGET_NOT_FOUND",
    fields.length ? "More than one editable field has focus" : "Focus an editable text field before sending text",
    { retryable: true, details: { dispatchState: "not-sent", matchCount: fields.length } });
  return fields[0];
}

export class HypiumAutomationDriver {
  private readonly gestures = new Map<string, Promise<GestureConnection>>();
  private readonly activeTouches = new Map<string, LiveTouch>();
  private readonly openGesture: NonNullable<HypiumAutomationDriverOptions["openGesture"]>;
  private readonly importDriver: () => Promise<HypiumModule>;
  private readonly now: () => number;
  private readonly preparePrivacy: () => void;
  private modulePromise?: Promise<HypiumModule>;
  private readonly sessions = new Map<string, Promise<HypiumDriver>>();
  private readonly ready = new Map<string, HypiumDriver>();
  private readonly cooldowns = new Map<string, number>();

  constructor(options: HypiumAutomationDriverOptions) {
    this.openGesture = options.openGesture ?? (driver => openGestureConnection(driver.device, allocatePioraPort));
    this.importDriver = options.importDriver ?? (async () => {
      configureHypiumPorts();
      const imported = await import("hypium-driver");
      return ((imported as { default?: HypiumModule }).default ?? imported) as HypiumModule;
    });
    this.now = options.now ?? Date.now;
    this.preparePrivacy = options.preparePrivacy ?? disableHypiumTelemetry;
  }

  private async module(): Promise<HypiumModule> {
    if (!this.modulePromise) {
      this.preparePrivacy();
      this.modulePromise = this.importDriver().catch((error) => {
        this.modulePromise = undefined;
        throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Unable to load hypium-driver", { cause: error, retryable: true, details: { dispatchState: "not-sent" } });
      });
    }
    return await this.modulePromise;
  }

  private async connect(serial: string): Promise<HypiumDriver> {
    const coolingUntil = this.cooldowns.get(serial) ?? 0;
    if (coolingUntil > this.now()) {
      throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Hypium is cooling down after a connection failure", {
        details: { dispatchState: "not-sent", retryAt: new Date(coolingUntil).toISOString() }, retryable: true,
      });
    }
    const existing = this.sessions.get(serial);
    if (existing) return await existing;
    const connection = (async () => {
      const driverModule = await this.module();
      try {
        const rawConnection = driverModule.UiDriver.connect({
          deviceSn: serial,
          hdcExecTimeout: 15_000,
          rpcTimeout: 30_000,
          implicitWaitTime: 1_000,
          samplingTime: 15,
        });
        let driver: HypiumDriver;
        try {
          driver = await timeout(rawConnection, CONNECT_TIMEOUT_MS, "Timed out connecting the Hypium automation driver");
        } catch (error) {
          // UiDriver.connect has no cancellation API. If it completes after our
          // bounded wait, close the orphaned RPC session instead of leaking it.
          void rawConnection.then(async (lateDriver) => await lateDriver.disconnect()).catch(() => undefined);
          throw error;
        }
        this.ready.set(serial, driver);
        this.cooldowns.delete(serial);
        return driver;
      } catch (error) {
        this.cooldowns.set(serial, this.now() + DRIVER_COOLDOWN_MS);
        throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Hypium could not connect to the Harmony device", {
          cause: error, retryable: true, details: { dispatchState: "not-sent" },
        });
      }
    })();
    this.sessions.set(serial, connection);
    try {
      return await connection;
    } catch (error) {
      if (this.sessions.get(serial) === connection) this.sessions.delete(serial);
      throw error;
    }
  }

  private async run<T>(serial: string, operation: string, signal: AbortSignal | undefined, task: (driver: HypiumDriver, module: HypiumModule) => Promise<T>): Promise<T> {
    if (this.activeTouchIds.has(serial) && !["pointer_move", "pointer_up", "pointer_release", "display_geometry"].includes(operation)) {
      throw new HarmonyError("DEVICE_BUSY", "A manual pointer is still held");
    }
    const driver = await withAbort(this.connect(serial), signal, () => { void this.invalidate(serial); });
    const driverModule = await this.module();
    try {
      return await withAbort(task(driver, driverModule), signal, () => { void this.invalidate(serial); });
    } catch (error) {
      if (error instanceof HarmonyError) throw error;
      await this.invalidate(serial);
      throw new HarmonyError("AUTOMATION_DRIVER_FAILED", "Hypium automation failed", {
        cause: error, details: { operation }, retryable: true,
      });
    }
  }

  async tryRun<T>(serial: string, operation: string, signal: AbortSignal | undefined, task: (driver: HypiumDriver, module: HypiumModule) => Promise<T>): Promise<{ used: true; value: T } | { used: false }> {
    try {
      const value = await this.run(serial, operation, signal, task);
      return { used: true, value };
    } catch (error) {
      if (error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_UNAVAILABLE") return { used: false };
      throw error;
    }
  }

  async execute(serial: string, operation: string, args: unknown[], signal?: AbortSignal): Promise<{ used: true; value: unknown } | { used: false }> {
    return await this.tryRun(serial, operation, signal, async (driver, module) => {
      if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Driver operation cancelled", { details: { dispatchState: "not-sent" } });
      if (operation === "display_geometry") {
        // UiDriver.getDisplaySize drops displayId; retain it from the same
        // public RPC so secondary/unknown targets never become primary input.
        const before = await driver.getDisplayRotation();
        const size = JSON.parse(await driver.rpcClient.callUiTestRpc("Driver.getDisplaySize", driver)) as { x?: unknown; y?: unknown; displayId?: unknown };
        const after = await driver.getDisplayRotation();
        if (before !== after) throw new HarmonyError("STALE_SNAPSHOT", "Display rotated during geometry observation");
        if (![0, 1, 2, 3].includes(after) || size.displayId !== 0 || ![size.x,size.y].every(value => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 16384)) {
          throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Primary display geometry is unavailable from the control channel");
        }
        // Geometry preparation already established the agent. Open our input
        // transport now, without claiming a lease or injecting a phone event.
        await this.gestureConnection(serial, driver, module).catch(() => undefined);
        return { nativeWidth: size.x as number, nativeHeight: size.y as number, displayId: "0", displayRotation: after * 90 };
      }
      const n = args.map(Number);
      if (operation.startsWith("pointer_")) {
        const id = String(args[0]);
        if (operation === "pointer_release" && !this.activeTouches.has(serial)) {
          // Explicit parent-owned cleanup after a worker restart. Only UP is
          // permitted here; a lost DOWN/MOVE is never reconstructed or replayed.
          const { channel } = await this.gestureConnection(serial, driver, module);
          await channel.touch("up", Number(args[1]), Number(args[2]));
          return;
        }
        if (operation === "pointer_down") {
          const touch = await this.beginTouch(serial, driver, module, signal, 10_000);
          this.activeTouchIds.set(serial, id);
          await touch.down({ x: Number(args[1]), y: Number(args[2]) });
        } else {
          const touch = this.activeTouches.get(serial);
          if (!touch || this.activeTouchIds.get(serial) !== id) throw new HarmonyError("STALE_SNAPSHOT", "Pointer belongs to an expired gesture", { details: { reason: touch ? "foreign-pointer" : "pointer-session-lost" } });
          if (operation === "pointer_move") await touch.move({ x: Number(args[1]), y: Number(args[2]) });
          else if (operation === "pointer_up" || operation === "pointer_release") {
            try { await touch.up(); }
            finally { this.activeTouches.delete(serial); this.activeTouchIds.delete(serial); }
          } else throw new HarmonyError("INVALID_ARGUMENT", "Unsupported pointer phase");
        }
        return;
      }
      if (this.activeTouchIds.has(serial)) throw new HarmonyError("DEVICE_BUSY", "A manual pointer is still held");
      if (operation === "tap") {
        const touch = await this.beginTouch(serial, driver, module, signal);
        try { await touch.down({ x: n[0], y: n[1] }); }
        finally { try { await touch.up(); } finally { this.activeTouches.delete(serial); } }
        return;
      }
      if (operation === "double_tap") return await driver.doubleClick(n[0], n[1]);
      if (operation === "long_press") return await driver.longClick(n[0], n[1]);
      if (operation === "swipe" || operation === "drag") return await driver[operation](n[0], n[1], n[2], n[3], n[4]);
      if (operation === "fling") return await driver.fling(n[0], n[1], n[2], n[3], 20, n[4]);
      if (operation === "press_key") {
        if (args[0] === "back") return await driver.pressBack();
        if (args[0] === "home") return await driver.pressHome();
        if (args[0] === "volume_up" || args[0] === "volume_down" || args[0] === "power") return await driver.triggerKey(physicalKeyCode(args[0]));
        if (args[0] !== "recents" && args[0] !== "enter") throw new HarmonyError("INVALID_ARGUMENT", "Unsupported logical key");
        return await driver.triggerKey(args[0] === "recents" ? module.KeyCode.APPSELECT : module.KeyCode.ENTER);
      }
      if (operation === "input_text") {
        const component = await focusedTextComponent(driver, module);
        if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Text operation cancelled");
        await component.inputText(String(args[0]));
        if (await component.getText() !== args[0]) throw new HarmonyError("SCENARIO_FAILED", "Focused text readback mismatch", { details: { dispatchState: "sent", verification: "failed" } });
        return;
      }
      throw new HarmonyError("INVALID_ARGUMENT", "Unsupported worker operation");
    });
  }

  async semanticAction(serial: string, request: HarmonySemanticActionRequest, signal?: AbortSignal): Promise<HarmonySemanticActionResult> {
    if (request.action === "scroll_find") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Use bounded layout scrolling; Hypium scrollSearch cannot enforce a swipe budget", { details: { dispatchState: "not-sent" } });
    return await this.run(serial, request.action, signal, async (driver, module) => {
      const timeoutMs = Math.max(100, Math.min(60_000, Math.round(request.timeoutMs ?? 3_000)));
      const component = await resolveSemanticComponent(driver, module, request.selector, timeoutMs);
      if (!await component.exist()) throw new HarmonyError("UI_TARGET_NOT_FOUND", "No UI element matched the requested selector", { retryable: true });
      const check = () => { if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Semantic action was cancelled", { details: { dispatchState: "not-sent" } }); };
      check();
      if (request.action === "tap") await component.click();
      else if (request.action === "double_tap") await component.doubleClick();
      else if (request.action === "long_press") await component.longClick();
      else if (request.action === "input_text" || request.action === "clear_text") {
        if (request.action === "input_text" && typeof request.text !== "string") throw new HarmonyError("INVALID_ARGUMENT", "Semantic text input requires text");
        const before = await component.getText();
        const expected = request.action === "clear_text" ? "" : (request.append ? before : "") + request.text;
        check();
        if (request.action === "clear_text") await component.clearText();
        else await component.inputText(request.text!, request.append ? { addition: true } : undefined);
        const after = await component.getText();
        if (after !== expected) throw new HarmonyError("SCENARIO_FAILED", "Text readback did not match the requested value", {
          details: { dispatchState: "sent", effect: "unknown", verification: "failed", expectedLength: expected.length, actualLength: after.length },
        });
      }
      return { strategy: "hypium_semantic_rpc" };
    });
  }

  async waitForIdle(serial: string, idleMs: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const result = await this.tryRun(serial, "wait_for_idle", signal, async (driver) => {
      await driver.waitForIdle(idleMs, timeoutMs);
      return true;
    });
    return result.used;
  }

  status(): HypiumAutomationStatus[] {
    const serials = new Set([...this.sessions.keys(), ...this.cooldowns.keys()]);
    return [...serials].map((serial) => {
      if (this.ready.has(serial)) return { serial, state: "ready" as const };
      if (this.sessions.has(serial)) return { serial, state: "connecting" as const };
      const retryAt = this.cooldowns.get(serial);
      return retryAt && retryAt > this.now()
        ? { serial, state: "cooldown" as const, retryAt: new Date(retryAt).toISOString() }
        : { serial, state: "idle" as const };
    });
  }

  async invalidate(serial: string): Promise<void> {
    this.activeTouchIds.delete(serial);
    const touch = this.activeTouches.get(serial); this.activeTouches.delete(serial);
    const gesture = this.gestures.get(serial); this.gestures.delete(serial);
    const promise = this.sessions.get(serial);
    this.sessions.delete(serial);
    const driver = this.ready.get(serial);
    this.ready.delete(serial);
    const resolved = driver ?? await promise?.catch(() => undefined);
    try { await touch?.up(); }
    finally {
      try { await (await gesture?.catch(() => undefined))?.close(); }
      finally { if (resolved) await timeout(Promise.resolve(resolved.disconnect()), 5_000, "Timed out disconnecting Hypium").catch(() => undefined); }
    }
  }

  private readonly activeTouchIds = new Map<string, string>();

  private gestureConnection(serial: string, driver: HypiumDriver, module: HypiumModule): Promise<GestureConnection> {
    let connection = this.gestures.get(serial);
    if (!connection) {
      connection = this.openGesture(driver, module);
      this.gestures.set(serial, connection);
      void connection.catch(() => { if (this.gestures.get(serial) === connection) this.gestures.delete(serial); });
    }
    return connection;
  }

  private async beginTouch(serial: string, driver: HypiumDriver, module: HypiumModule, signal?: AbortSignal, maxHoldMs = 2000): Promise<LiveTouch> {
    if (this.activeTouches.has(serial)) throw new HarmonyError("DEVICE_BUSY", "A live touch is already active");
    const { channel } = await this.gestureConnection(serial, driver, module);
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Touch cancelled before dispatch");
    const touch = new LiveTouch(channel, {
      maxHoldMs,
      validate(point) {
        if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Touch cancelled before dispatch");
        if (![point.x, point.y].every(value => Number.isInteger(value) && value >= 0)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid touch coordinates");
      },
      recoverRelease: async point => {
        const recovery = await this.openGesture(driver, module);
        try { await recovery.channel.touch("up", point.x, point.y); }
        finally { await recovery.close(); }
      },
      onError: () => { /* The awaiting down/up operation propagates the original failure. */ },
    });
    this.activeTouches.set(serial, touch); return touch;
  }

  async reset(serial?: string): Promise<void> {
    if (serial) {
      this.cooldowns.delete(serial);
      await this.invalidate(serial);
      return;
    }
    const serials = new Set([...this.sessions.keys(), ...this.ready.keys(), ...this.cooldowns.keys()]);
    this.cooldowns.clear();
    await Promise.all([...serials].map(async (value) => await this.invalidate(value)));
  }
}
