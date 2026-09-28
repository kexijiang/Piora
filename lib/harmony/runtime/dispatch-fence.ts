import { HarmonyError } from "../errors";
import type { HarmonyAutomationBackend } from "../types";

const WRITES = new Set<keyof HarmonyAutomationBackend>([
  "tap", "doubleTap", "longPress", "swipe", "drag", "fling", "inputText", "pressKey",
  "launchApp", "installPackage", "stopApp", "clearAppData", "uninstallPackage", "setAppEnabled", "pushFile", "createDirectory", "deletePath", "renamePath", "chmodPath", "saveTextFile", "runShellCommand", "semanticAction", "startRecording",
  "keyHold", "touchHold",
  "appTestAudio",
]);

/** Recheck at every physical dispatch, including the second call of a compound step. */
export function fencedBackend(backend: HarmonyAutomationBackend, signal: AbortSignal, check: () => void,
  prepare?: (method: keyof HarmonyAutomationBackend, args: unknown[]) => Promise<unknown[]>,
  failed?: (method: string, args: unknown[], error: unknown) => void): HarmonyAutomationBackend {
  return new Proxy(backend, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (WRITES.has(key as keyof HarmonyAutomationBackend)) {
          if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device dispatch was cancelled", { details: { dispatchState: "not-sent" } });
          check();
          if (prepare) args = await prepare(key as keyof HarmonyAutomationBackend, args);
          if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device dispatch was cancelled");
          check();
        }
        try { return await Reflect.apply(value, target, args); }
        catch (error) { if (WRITES.has(key as keyof HarmonyAutomationBackend)) failed?.(String(key), args, error); throw error; }
      };
    },
  });
}
