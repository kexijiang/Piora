import { actionCatalog } from "../contracts/actions";
import type { HarmonyActionCapability } from "../contracts/capabilities";

/** Help text proves command availability only, never a physical action's effect. */
export function capabilitiesFromHelp(help: { uitest?: string; input?: string; uinput?: string }, now = new Date().toISOString()): HarmonyActionCapability[] {
  const commands: Record<string, string> = { tap: "click", tap_ref: "click", double_tap: "doubleClick", long_press: "longClick", swipe: "swipe", drag: "drag", fling: "fling", press_key: "keyEvent" };
  return Object.entries(actionCatalog).map(([action]) => {
    let status: HarmonyActionCapability["status"] = "unknown";
    let reason = "No verified provider evidence for this action on this device";
    let evidence: HarmonyActionCapability["evidence"] = "declared";
    if (["key_hold", "touch_hold", "voice_input", "open_assistant"].includes(action)) { status = "needs-calibration"; reason = "Requires device/version-specific release or acoustic calibration; registration is not physical verification"; }
    else if (commands[action]) {
      if (help.input) { status = new RegExp(`\\b${commands[action]}\\b`).test(help.input) ? "supported" : "unsupported"; evidence = "probed"; reason = status === "supported" ? "Present in the device's UiTest help; physical effect is not yet verified" : "Not advertised by the device's UiTest help"; }
    } else if (["wait_for", "assert", "scroll_find"].includes(action) && help.uitest?.includes("dumpLayout")) {
      status = "supported"; evidence = "probed"; reason = "Layout command present; each observation must still pass quality checks";
    } else if (["stop_device", "emergency_stop", "checkpoint"].includes(action)) { status = "supported"; reason = "Host runtime operation"; }
    return { action, status, reason, provider: commands[action] ? "hdc-uitest" : "piora", evidence, probedAt: now };
  });
}
