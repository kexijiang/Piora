import { extname, isAbsolute } from "node:path";

import { asHarmonyError, HarmonyError } from "./errors";
import { findHarmonyNodes, harmonyNodeCenter, resolveHarmonyNode, validateHarmonySelector } from "./selector";
import type {
  HarmonyAutomationBackend,
  HarmonyScenarioOptions,
  HarmonyScenarioPolicy,
  HarmonyScenarioResult,
  HarmonyScenarioStep,
  HarmonyScenarioStepResult,
  HarmonySnapshot,
  HarmonyUiNode,
  HarmonyUiSelector,
  HarmonyWaitCondition,
} from "./types";

const MAX_SCENARIO_STEPS = 64;
const MAX_TEXT_LENGTH = 8_192;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_SCENARIO_TIMEOUT_MS = 5 * 60_000;
const APP_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
const SCENARIO_ACTIONS = new Set<HarmonyScenarioStep["action"]>([
  "tap", "double_tap", "long_press", "input_text", "clear_text", "scroll_find",
  "swipe", "fling", "press_key", "launch_app", "stop_app", "clear_app_data",
  "uninstall_app", "install_app", "wait_for", "assert", "wait_idle", "checkpoint",
]);

export interface HarmonyScenarioExecutorContext {
  serial: string;
  generation: number;
  backend: HarmonyAutomationBackend;
  signal: AbortSignal;
  now?: () => number;
  capture(options: { includeTree: boolean; includeScreenshot: boolean }, signal?: AbortSignal): Promise<HarmonySnapshot>;
  invalidateSnapshot(): void;
  beforeStep?(): void;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new HarmonyError("INVALID_ARGUMENT", `${name} must be between ${minimum} and ${maximum}`);
  }
  return Math.round(resolved);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredScenarioString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new HarmonyError("INVALID_ARGUMENT", `${name} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function optionalScenarioBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HarmonyError("INVALID_ARGUMENT", `${name} must be a boolean`);
  return value;
}

function validateWaitCondition(value: unknown, name: string): asserts value is HarmonyWaitCondition {
  if (!record(value)) throw new HarmonyError("INVALID_ARGUMENT", `${name} must be an object`);
  validateHarmonySelector(value.selector as HarmonyUiSelector);
  optionalScenarioBoolean(value.exists, `${name}.exists`);
  if (value.timeoutMs !== undefined) bounded(value.timeoutMs as number, 0, 100, 60_000, `${name}.timeoutMs`);
  if (value.intervalMs !== undefined) bounded(value.intervalMs as number, 0, 100, 5_000, `${name}.intervalMs`);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new HarmonyError("COMMAND_ABORTED", "Harmony scenario was cancelled", { retryable: true }));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new HarmonyError("COMMAND_ABORTED", "Harmony scenario was cancelled", { retryable: true }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
  });
}

function screenBounds(nodes: readonly HarmonyUiNode[], preferred?: HarmonyUiNode): { left: number; top: number; right: number; bottom: number } {
  if (preferred?.bounds) return preferred.bounds;
  const bounds = nodes.map((node) => node.bounds).filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (bounds.length === 0) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The UI tree has no bounds for a directional gesture");
  return {
    left: Math.min(...bounds.map((value) => value.left)),
    top: Math.min(...bounds.map((value) => value.top)),
    right: Math.max(...bounds.map((value) => value.right)),
    bottom: Math.max(...bounds.map((value) => value.bottom)),
  };
}

export function gestureCoordinates(
  nodes: readonly HarmonyUiNode[],
  direction: "left" | "right" | "up" | "down",
  preferred?: HarmonyUiNode,
): { fromX: number; fromY: number; toX: number; toY: number } {
  const bounds = screenBounds(nodes, preferred);
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const left = Math.round(bounds.left + width * 0.2);
  const right = Math.round(bounds.left + width * 0.8);
  const top = Math.round(bounds.top + height * 0.25);
  const bottom = Math.round(bounds.top + height * 0.75);
  const centerX = Math.round(bounds.left + width * 0.5);
  const centerY = Math.round(bounds.top + height * 0.5);
  if (direction === "left") return { fromX: right, fromY: centerY, toX: left, toY: centerY };
  if (direction === "right") return { fromX: left, fromY: centerY, toX: right, toY: centerY };
  if (direction === "up") return { fromX: centerX, fromY: bottom, toX: centerX, toY: top };
  return { fromX: centerX, fromY: top, toX: centerX, toY: bottom };
}

function normalizePolicy(policy: HarmonyScenarioPolicy | undefined): Required<HarmonyScenarioPolicy> {
  const candidate: unknown = policy;
  if (candidate !== undefined && !record(candidate)) {
    throw new HarmonyError("INVALID_ARGUMENT", "policy must be an object");
  }
  return {
    defaultTimeoutMs: bounded(policy?.defaultTimeoutMs, 10_000, 100, 60_000, "policy.defaultTimeoutMs"),
    defaultIntervalMs: bounded(policy?.defaultIntervalMs, 250, 100, 5_000, "policy.defaultIntervalMs"),
    settleAfterAction: optionalScenarioBoolean(policy?.settleAfterAction, "policy.settleAfterAction") ?? true,
    captureFinalScreenshot: optionalScenarioBoolean(policy?.captureFinalScreenshot, "policy.captureFinalScreenshot") ?? false,
  };
}

export function validateHarmonyScenario(options: HarmonyScenarioOptions): void {
  if (!Array.isArray(options.steps) || options.steps.length < 1 || options.steps.length > MAX_SCENARIO_STEPS) {
    throw new HarmonyError("INVALID_ARGUMENT", `A Harmony scenario requires between 1 and ${MAX_SCENARIO_STEPS} steps`);
  }
  normalizePolicy(options.policy);
  for (const [index, typedStep] of options.steps.entries()) {
    if (!record(typedStep)) throw new HarmonyError("INVALID_ARGUMENT", `Scenario step ${index} is invalid`);
    const step = typedStep as Record<string, unknown>;
    const prefix = `steps[${index}]`;
    if (typeof step.action !== "string" || !SCENARIO_ACTIONS.has(step.action as HarmonyScenarioStep["action"])) {
      throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.action is unsupported`);
    }
    if (step.id !== undefined) requiredScenarioString(step.id, `${prefix}.id`, 120);
    const wait = () => {
      if (step.waitFor !== undefined) validateWaitCondition(step.waitFor, `${prefix}.waitFor`);
    };
    const selector = () => validateHarmonySelector(step.selector as HarmonyUiSelector);

    if (["tap", "double_tap", "long_press", "clear_text"].includes(step.action)) {
      selector();
      wait();
    } else if (step.action === "input_text") {
      selector();
      const text = requiredScenarioString(step.text, `${prefix}.text`, MAX_TEXT_LENGTH);
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
      }
      optionalScenarioBoolean(step.append, `${prefix}.append`);
      wait();
    } else if (step.action === "scroll_find") {
      selector();
      if (step.container !== undefined) validateHarmonySelector(step.container as HarmonyUiSelector);
      if (step.direction !== undefined && step.direction !== "up" && step.direction !== "down") {
        throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.direction is invalid`);
      }
      if (step.maxSwipes !== undefined) bounded(step.maxSwipes as number, 8, 1, 30, `${prefix}.maxSwipes`);
      optionalScenarioBoolean(step.tap, `${prefix}.tap`);
      wait();
    } else if (step.action === "swipe" || step.action === "fling") {
      if (!["left", "right", "up", "down"].includes(step.direction as string)) {
        throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.direction is invalid`);
      }
      if (step.durationMs !== undefined) bounded(step.durationMs as number, 500, 50, 10_000, `${prefix}.durationMs`);
      wait();
    } else if (step.action === "press_key") {
      if (!["back", "home", "recents", "enter"].includes(step.key as string)) {
        throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.key is invalid`);
      }
      wait();
    } else if (step.action === "launch_app") {
      const bundleName = requiredScenarioString(step.bundleName, `${prefix}.bundleName`, 256);
      if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.bundleName is invalid`);
      if (step.abilityName !== undefined) {
        const abilityName = requiredScenarioString(step.abilityName, `${prefix}.abilityName`, 256);
        if (!APP_IDENTIFIER_PATTERN.test(abilityName)) throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.abilityName is invalid`);
      }
      wait();
    } else if (step.action === "stop_app" || step.action === "clear_app_data" || step.action === "uninstall_app") {
      const bundleName = requiredScenarioString(step.bundleName, `${prefix}.bundleName`, 256);
      if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.bundleName is invalid`);
    } else if (step.action === "install_app") {
      const hapPath = requiredScenarioString(step.hapPath, `${prefix}.hapPath`, 4_096);
      if (!isAbsolute(hapPath) || extname(hapPath).toLocaleLowerCase() !== ".hap") {
        throw new HarmonyError("INVALID_ARGUMENT", `${prefix}.hapPath must be an absolute HAP path`);
      }
      optionalScenarioBoolean(step.replace, `${prefix}.replace`);
    } else if (step.action === "wait_for" || step.action === "assert") {
      validateWaitCondition(step.condition, `${prefix}.condition`);
    } else if (step.action === "wait_idle") {
      const idleMs = bounded(step.idleMs as number | undefined, 250, 50, 10_000, `${prefix}.idleMs`);
      bounded(step.timeoutMs as number | undefined, 5_000, idleMs, 60_000, `${prefix}.timeoutMs`);
    } else if (step.action === "checkpoint") {
      requiredScenarioString(step.name, `${prefix}.name`, 120);
    }
  }
}

async function waitFor(
  context: HarmonyScenarioExecutorContext,
  condition: HarmonyWaitCondition,
  policy: Required<HarmonyScenarioPolicy>,
  assertion = false,
): Promise<HarmonySnapshot> {
  const timeoutMs = assertion ? 0 : bounded(condition.timeoutMs, policy.defaultTimeoutMs, 100, 60_000, "condition.timeoutMs");
  const intervalMs = bounded(condition.intervalMs, policy.defaultIntervalMs, 100, 5_000, "condition.intervalMs");
  const deadline = (context.now ?? Date.now)() + timeoutMs;
  let latest: HarmonySnapshot;
  do {
    context.beforeStep?.();
    latest = await context.capture({ includeTree: true, includeScreenshot: false }, context.signal);
    const matches = findHarmonyNodes(latest.nodes ?? [], condition.selector);
    const present = condition.selector.index === undefined
      ? matches.length > 0
      : matches.length > condition.selector.index;
    if ((condition.exists ?? true) ? present : !present) return latest;
    if ((context.now ?? Date.now)() >= deadline) break;
    await delay(Math.min(intervalMs, Math.max(1, deadline - (context.now ?? Date.now)())), context.signal);
  } while ((context.now ?? Date.now)() <= deadline);
  throw new HarmonyError(assertion ? "SCENARIO_FAILED" : "UI_TARGET_NOT_FOUND", assertion
    ? "A Harmony scenario assertion failed"
    : "Timed out waiting for the requested Harmony UI state", {
    details: { expectedExists: condition.exists ?? true, timeoutMs }, retryable: !assertion,
  });
}

async function semanticOrLayout(
  context: HarmonyScenarioExecutorContext,
  step: Extract<HarmonyScenarioStep, { action: "tap" | "double_tap" | "long_press" | "input_text" | "clear_text" }>,
  policy: Required<HarmonyScenarioPolicy>,
): Promise<string> {
  if (context.backend.semanticAction) {
    try {
      const result = await context.backend.semanticAction(context.serial, {
        action: step.action,
        selector: step.selector,
        ...(step.action === "input_text" ? { text: step.text, append: step.append } : {}),
        timeoutMs: policy.defaultTimeoutMs,
      }, context.signal);
      context.invalidateSnapshot();
      return result.strategy;
    } catch (error) {
      const normalized = asHarmonyError(error);
      if (normalized.code !== "CAPABILITY_UNAVAILABLE" && normalized.code !== "AUTOMATION_DRIVER_UNAVAILABLE") throw error;
    }
  }

  const snapshot = await context.capture({ includeTree: true, includeScreenshot: false }, context.signal);
  const node = resolveHarmonyNode(snapshot.nodes ?? [], step.selector);
  const point = harmonyNodeCenter(node);
  context.invalidateSnapshot();
  if (step.action === "tap") await context.backend.tap(context.serial, point.x, point.y, context.signal);
  else if (step.action === "double_tap") {
    if (!context.backend.doubleTap) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Double tap is unavailable");
    await context.backend.doubleTap(context.serial, point.x, point.y, context.signal);
  } else if (step.action === "long_press") {
    if (!context.backend.longPress) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Long press is unavailable");
    await context.backend.longPress(context.serial, point.x, point.y, context.signal);
  } else if (step.action === "input_text") {
    await context.backend.tap(context.serial, point.x, point.y, context.signal);
    await context.backend.inputText(context.serial, step.text, context.signal);
  } else {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Clearing a semantic text component requires the Hypium automation driver");
  }
  return "layout_revalidated_coordinates";
}

async function scrollFind(
  context: HarmonyScenarioExecutorContext,
  step: Extract<HarmonyScenarioStep, { action: "scroll_find" }>,
  policy: Required<HarmonyScenarioPolicy>,
): Promise<string> {
  if (context.backend.semanticAction && step.container) {
    try {
      const result = await context.backend.semanticAction(context.serial, {
        action: "scroll_find",
        selector: step.selector,
        container: step.container,
        tapAfterScroll: step.tap,
        timeoutMs: policy.defaultTimeoutMs,
      }, context.signal);
      context.invalidateSnapshot();
      return result.strategy;
    } catch (error) {
      const normalized = asHarmonyError(error);
      if (normalized.code !== "CAPABILITY_UNAVAILABLE" && normalized.code !== "AUTOMATION_DRIVER_UNAVAILABLE"
        && normalized.code !== "UI_TARGET_NOT_FOUND") throw error;
    }
  }

  const maxSwipes = bounded(step.maxSwipes, 8, 1, 30, "scroll_find.maxSwipes");
  const direction = step.direction ?? "down";
  for (let attempt = 0; attempt <= maxSwipes; attempt += 1) {
    const snapshot = await context.capture({ includeTree: true, includeScreenshot: false }, context.signal);
    const matches = findHarmonyNodes(snapshot.nodes ?? [], step.selector);
    if (matches.length > 0) {
      const node = resolveHarmonyNode(snapshot.nodes ?? [], step.selector);
      if (step.tap) {
        const point = harmonyNodeCenter(node);
        context.invalidateSnapshot();
        await context.backend.tap(context.serial, point.x, point.y, context.signal);
      }
      return "layout_scroll_search";
    }
    if (attempt === maxSwipes) break;
    const container = step.container ? resolveHarmonyNode(snapshot.nodes ?? [], step.container) : undefined;
    // "down" means advancing toward content below, which requires an upward finger gesture.
    const gesture = gestureCoordinates(snapshot.nodes ?? [], direction === "down" ? "up" : "down", container);
    context.invalidateSnapshot();
    await context.backend.swipe(context.serial, gesture.fromX, gesture.fromY, gesture.toX, gesture.toY, 350, context.signal);
    if (context.backend.waitForIdle) await context.backend.waitForIdle(context.serial, 150, 2_000, context.signal).catch(() => undefined);
  }
  throw new HarmonyError("UI_TARGET_NOT_FOUND", "The requested UI target was not found after bounded scrolling", {
    details: { maxSwipes }, retryable: true,
  });
}

async function executeStep(
  context: HarmonyScenarioExecutorContext,
  step: HarmonyScenarioStep,
  policy: Required<HarmonyScenarioPolicy>,
): Promise<string | undefined> {
  context.beforeStep?.();
  if (step.action === "checkpoint") return "checkpoint";
  if (step.action === "wait_for") {
    await waitFor(context, step.condition, policy);
    return "semantic_wait";
  }
  if (step.action === "assert") {
    await waitFor(context, step.condition, policy, true);
    return "semantic_assertion";
  }
  if (step.action === "wait_idle") {
    const idleMs = bounded(step.idleMs, 250, 50, 10_000, "wait_idle.idleMs");
    const timeoutMs = bounded(step.timeoutMs, 5_000, idleMs, 60_000, "wait_idle.timeoutMs");
    if (context.backend.waitForIdle) await context.backend.waitForIdle(context.serial, idleMs, timeoutMs, context.signal);
    else await delay(idleMs, context.signal);
    return context.backend.waitForIdle ? "driver_idle" : "bounded_delay";
  }
  if (step.action === "tap" || step.action === "double_tap" || step.action === "long_press"
    || step.action === "input_text" || step.action === "clear_text") {
    const strategy = await semanticOrLayout(context, step, policy);
    if (step.waitFor) await waitFor(context, step.waitFor, policy);
    else if (policy.settleAfterAction && context.backend.waitForIdle) {
      await context.backend.waitForIdle(context.serial, 150, 2_000, context.signal).catch(() => undefined);
    }
    return strategy;
  }
  if (step.action === "scroll_find") {
    const strategy = await scrollFind(context, step, policy);
    if (step.waitFor) await waitFor(context, step.waitFor, policy);
    return strategy;
  }
  if (step.action === "swipe" || step.action === "fling") {
    const snapshot = await context.capture({ includeTree: true, includeScreenshot: false }, context.signal);
    const gesture = gestureCoordinates(snapshot.nodes ?? [], step.direction);
    context.invalidateSnapshot();
    if (step.action === "fling" && context.backend.fling) {
      await context.backend.fling(context.serial, gesture.fromX, gesture.fromY, gesture.toX, gesture.toY, step.durationMs, context.signal);
    } else {
      await context.backend.swipe(context.serial, gesture.fromX, gesture.fromY, gesture.toX, gesture.toY, step.durationMs, context.signal);
    }
    if (step.waitFor) await waitFor(context, step.waitFor, policy);
    else if (policy.settleAfterAction && context.backend.waitForIdle) {
      await context.backend.waitForIdle(context.serial, 150, 2_000, context.signal).catch(() => undefined);
    }
    return "relative_gesture";
  }
  if (step.action === "press_key") {
    context.invalidateSnapshot();
    await context.backend.pressKey(context.serial, step.key, context.signal);
    if (step.waitFor) await waitFor(context, step.waitFor, policy);
    return "driver_key";
  }
  if (step.action === "launch_app") {
    context.invalidateSnapshot();
    await context.backend.launchApp(context.serial, step.bundleName, step.abilityName, context.signal);
    if (step.waitFor) await waitFor(context, step.waitFor, policy);
    return "application_lifecycle";
  }
  if (step.action === "stop_app") {
    if (!context.backend.stopApp) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Stopping applications is unavailable");
    context.invalidateSnapshot();
    await context.backend.stopApp(context.serial, step.bundleName, context.signal);
    return "application_lifecycle";
  }
  if (step.action === "clear_app_data") {
    if (!context.backend.clearAppData) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Clearing application data is unavailable");
    context.invalidateSnapshot();
    await context.backend.clearAppData(context.serial, step.bundleName, context.signal);
    return "application_lifecycle";
  }
  if (step.action === "uninstall_app") {
    if (!context.backend.uninstallPackage) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Uninstalling applications is unavailable");
    context.invalidateSnapshot();
    await context.backend.uninstallPackage(context.serial, step.bundleName, context.signal);
    return "application_lifecycle";
  }
  if (step.action === "install_app") {
    if (!context.backend.installPackage) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Installing applications is unavailable");
    context.invalidateSnapshot();
    await context.backend.installPackage(context.serial, step.hapPath, step.replace ?? true, context.signal);
    return "application_lifecycle";
  }
  throw new HarmonyError("INVALID_ARGUMENT", "Unsupported Harmony scenario step");
}

export async function runHarmonyScenario(
  options: HarmonyScenarioOptions,
  context: HarmonyScenarioExecutorContext,
): Promise<HarmonyScenarioResult> {
  validateHarmonyScenario(options);
  const now = context.now ?? Date.now;
  const started = now();
  const policy = normalizePolicy(options.policy);
  const results: HarmonyScenarioStepResult[] = [];
  let checkpoint: HarmonyScenarioResult["checkpoint"];
  const executionController = new AbortController();
  const forwardAbort = () => executionController.abort(context.signal.reason ?? "scenario_cancelled");
  if (context.signal.aborted) forwardAbort();
  else context.signal.addEventListener("abort", forwardAbort, { once: true });
  const scenarioTimeout = setTimeout(() => executionController.abort("scenario_timeout"), MAX_SCENARIO_TIMEOUT_MS);
  scenarioTimeout.unref?.();
  const executionContext: HarmonyScenarioExecutorContext = { ...context, signal: executionController.signal };

  try {
    for (const [index, step] of options.steps.entries()) {
      if (now() - started > MAX_SCENARIO_TIMEOUT_MS) {
        results.push({ index, ...(step.id ? { id: step.id } : {}), action: step.action, status: "failed", durationMs: 0, message: "Scenario time limit exceeded" });
        break;
      }
      const stepStarted = now();
      try {
        const strategy = await executeStep(executionContext, step, policy);
        if (step.action === "checkpoint") checkpoint = { name: step.name, stepIndex: index };
        results.push({
          index,
          ...(step.id ? { id: step.id } : {}),
          action: step.action,
          status: "passed",
          durationMs: Math.max(0, now() - stepStarted),
          ...(strategy ? { strategy } : {}),
        });
      } catch (error) {
        const normalized = asHarmonyError(error);
        if (context.signal.aborted) throw normalized;
        const timedOut = executionController.signal.aborted && executionController.signal.reason === "scenario_timeout";
        results.push({
          index,
          ...(step.id ? { id: step.id } : {}),
          action: step.action,
          status: "failed",
          durationMs: Math.max(0, now() - stepStarted),
          message: timedOut
            ? "[SCENARIO_FAILED] Harmony scenario exceeded the five-minute execution limit"
            : `[${normalized.code}] ${normalized.message}`,
        });
        break;
      }
    }

    let finalSnapshot: HarmonySnapshot | undefined;
    try {
      finalSnapshot = await executionContext.capture(
        { includeTree: true, includeScreenshot: policy.captureFinalScreenshot },
        executionContext.signal,
      );
    } catch {
      // A structured step result remains useful when the device disappears before final observation.
    }
    const completed = now();
    const failed = results.some((result) => result.status === "failed") || results.length !== options.steps.length;
    return {
      serial: context.serial,
      generation: finalSnapshot?.generation ?? context.generation,
      status: failed ? "failed" : "passed",
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(completed).toISOString(),
      durationMs: Math.max(0, completed - started),
      completedSteps: results.filter((result) => result.status === "passed").length,
      ...(checkpoint ? { checkpoint } : {}),
      steps: results,
      ...(finalSnapshot ? { finalSnapshot } : {}),
    };
  } finally {
    clearTimeout(scenarioTimeout);
    context.signal.removeEventListener("abort", forwardAbort);
  }
}
