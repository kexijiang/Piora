import { validateAction } from "./contracts/actions";
import { HarmonyError } from "./errors";
import type { HarmonyDeviceManager } from "./device-manager";

function requiredString(body: Record<string, unknown>, key: string, max = 512): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HarmonyError("INVALID_ARGUMENT", `${key} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function coordinate(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isFinite(value) || Number(value) < 0 || Number(value) > 100_000) {
    throw new HarmonyError("INVALID_ARGUMENT", `${key} must be a coordinate between 0 and 100000`);
  }
  return Math.round(Number(value));
}

function generation(body: Record<string, unknown>): number | undefined {
  if (body.generation === undefined) return undefined;
  if (!Number.isInteger(body.generation) || Number(body.generation) < 0) {
    throw new HarmonyError("INVALID_ARGUMENT", "generation must be a non-negative integer");
  }
  return Number(body.generation);
}

export async function dispatchHarmonyAction(manager: HarmonyDeviceManager, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    validateAction(body, "direct");
    if (body.action === "emergency_stop") {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 160) : undefined;
      await manager.emergencyStop(reason);
      return { dispatchBlocked: true, controls: manager.getState().controls };
    }

    const serial = requiredString(body, "serial", 160);
    if (body.action === "stop_device") return await manager.stopDevice(serial, "desktop-device-stop");
    const leaseToken = requiredString(body, "leaseToken", 256);
    if (body.coordinateSpace !== undefined && body.coordinateSpace !== "frame" && body.coordinateSpace !== "native") throw new HarmonyError("INVALID_ARGUMENT", "Unknown coordinateSpace");
    const common = { serial, leaseToken, signal: signal,
      ...(body.coordinateSpace ? { coordinateSpace: body.coordinateSpace as "frame" | "native" } : {}),
      ...(body.geometryId !== undefined ? { geometryId: requiredString(body, "geometryId", 128) } : {}),
    };
    let result: unknown;
    switch (body.action) {
      case "open_assistant":
        result = await manager.openAssistant({ ...common, profileId: requiredString(body, "profileId", 64) });
        break;
      case "voice_input":
        result = await manager.voiceInput({ ...common, audioAssetId: requiredString(body, "audioAssetId", 64), profileId: requiredString(body, "profileId", 64), requiredMode: body.requiredMode as "tap" | "push-to-talk" | undefined, timeoutMs: body.timeoutMs === undefined ? undefined : Number(body.timeoutMs) });
        break;
      case "key_hold":
        result = await manager.keyHold({ ...common, key: body.key as "power" | "volume_up" | "volume_down", durationMs: Number(body.durationMs) });
        break;
      case "touch_hold":
        result = await manager.touchHold({ ...common, x: coordinate(body, "x"), y: coordinate(body, "y"), durationMs: Number(body.durationMs), generation: generation(body) });
        break;
      case "initialize_mirror":
        result = await manager.initializeMirror(common);
        break;
      case "tap":
        result = await manager.tap({ ...common, x: coordinate(body, "x"), y: coordinate(body, "y"), generation: generation(body) });
        break;
      case "double_tap":
        result = await manager.doubleTap({ ...common, x: coordinate(body, "x"), y: coordinate(body, "y"), generation: generation(body) });
        break;
      case "long_press":
        result = await manager.longPress({ ...common, x: coordinate(body, "x"), y: coordinate(body, "y"), generation: generation(body) });
        break;
      case "tap_ref":
        if (!Number.isInteger(body.generation) || Number(body.generation) < 0) throw new HarmonyError("INVALID_ARGUMENT", "tap_ref requires generation");
        result = await manager.tapRef({ ...common, ref: requiredString(body, "ref", 256), generation: Number(body.generation) });
        break;
      case "swipe":
      case "fling":
      case "drag": {
        const duration = body.durationMs === undefined ? undefined : Number(body.durationMs);
        if (duration !== undefined && (!Number.isFinite(duration) || duration < 50 || duration > 30_000)) {
          throw new HarmonyError("INVALID_ARGUMENT", "durationMs must be between 50 and 30000");
        }
        const gesture = {
          ...common,
          fromX: coordinate(body, "fromX"), fromY: coordinate(body, "fromY"),
          toX: coordinate(body, "toX"), toY: coordinate(body, "toY"),
          ...(duration === undefined ? {} : { durationMs: Math.round(duration) }),
          generation: generation(body),
        };
        result = body.action === "drag"
          ? await manager.drag(gesture)
          : body.action === "fling"
            ? await manager.fling(gesture)
            : await manager.swipe(gesture);
        break;
      }
      case "input_text":
        result = await manager.inputText({ ...common, text: requiredString(body, "text", 8_192) });
        break;
      case "press_key": {
        const key = requiredString(body, "key", 16);
        if (key !== "back" && key !== "home" && key !== "recents" && key !== "enter") {
          throw new HarmonyError("INVALID_ARGUMENT", "Unsupported key");
        }
        result = await manager.pressKey({ ...common, key });
        break;
      }
      case "launch_app": {
        const bundleName = requiredString(body, "bundleName", 255);
        const abilityName = typeof body.abilityName === "string" && body.abilityName.trim() ? body.abilityName : undefined;
        if (!/^[A-Za-z0-9_.]+$/.test(bundleName) || (abilityName && !/^[A-Za-z0-9_.$]+$/.test(abilityName))) {
          throw new HarmonyError("INVALID_ARGUMENT", "Invalid bundle or ability name");
        }
        result = await manager.launchApp({ ...common, bundleName, abilityName });
        break;
      }
      case "stop_app":
      case "clear_app_data":
      case "uninstall_app": {
        const bundleName = requiredString(body, "bundleName", 255);
        if (body.action === "stop_app") result = await manager.stopApp({ ...common, bundleName });
        else if (body.action === "clear_app_data") result = await manager.clearAppData({ ...common, bundleName });
        else result = await manager.uninstallApp({ ...common, bundleName });
        break;
      }
      case "install_app":
        result = await manager.installPackage({ ...common, hapPath: requiredString(body, "hapPath", 4096), replace: body.replace === undefined ? true : body.replace as boolean });
        break;
      case "upload_file": {
        const kind = body.kind as "shared" | "sandbox";
        const scope = kind === "shared" ? { kind: "shared" as const } : { kind: "sandbox" as const, bundleName: requiredString(body, "bundleName", 256) };
        result = await manager.uploadFile({ ...common, scope, sourcePath: requiredString(body, "sourcePath", 4096), path: requiredString(body, "path", 4096), overwrite: body.overwrite === true });
        break;
      }
      default:
        throw new HarmonyError("INVALID_ARGUMENT", "Unsupported device action");
    }
    return result;
}
