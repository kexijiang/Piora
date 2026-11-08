import { HarmonyError } from "../errors";
import { validateHarmonySelector } from "../selector";
import type { HarmonySemanticActionRequest } from "../types";

export const WORKER_PROTOCOL_VERSION = 1;
export interface WorkerRequest { protocol: 1; epoch: string; id: number; deadline: number; method: "execute" | "semantic" | "idle"; serial: string; args: unknown[] }
export function validateWorkerRequest(value: unknown, epoch: string | undefined, serial: string | undefined): asserts value is WorkerRequest {
  const bad = () => { throw new HarmonyError("INVALID_ARGUMENT", "Invalid, expired or foreign worker request", { details: { dispatchState: "not-sent" } }); };
  if (!value || typeof value !== "object") return bad();
  const request = value as WorkerRequest;
  if (request.protocol !== WORKER_PROTOCOL_VERSION || !epoch || request.epoch !== epoch || !serial || request.serial !== serial || !Number.isSafeInteger(request.id) || request.id < 1 || !Number.isFinite(request.deadline) || request.deadline <= Date.now() || request.deadline - Date.now() > 60_000 || !Array.isArray(request.args) || Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) return bad();
  if (request.method === "idle") {
    if (request.args.length !== 2 || !request.args.every(n => Number.isInteger(n) && Number(n) >= 50 && Number(n) <= 60_000)) return bad();
  } else if (request.method === "execute") {
    const [operation, args] = request.args;
    if (request.args.length !== 2 || typeof operation !== "string" || !Array.isArray(args)) return bad();
    if (operation === "display_geometry") { if (args.length !== 0) return bad(); }
    else if (operation === "press_key") { if (args.length !== 1 || !["back", "home", "recents", "enter", "volume_up", "volume_down", "power"].includes(args[0])) return bad(); }
    else if (operation === "input_text") { if (args.length !== 1 || typeof args[0] !== "string" || args[0].includes("\0") || Buffer.byteLength(args[0]) > 16 * 1024) return bad(); }
    else {
      const length = ["tap", "double_tap", "long_press"].includes(operation) ? 2 : ["swipe", "drag", "fling"].includes(operation) ? 5 : 0;
      if (!length || args.length !== length || !args.every(n => Number.isInteger(n) && n >= 0 && n <= 100_000)) return bad();
    }
  } else if (request.method === "semantic") {
    const action = request.args[0] as HarmonySemanticActionRequest;
    if (request.args.length !== 1 || !action || !["tap", "double_tap", "long_press", "input_text", "clear_text", "scroll_find"].includes(action.action)) return bad();
    validateHarmonySelector(action.selector);
    if (action.text !== undefined && (typeof action.text !== "string" || action.text.includes("\0") || Buffer.byteLength(action.text) > 16 * 1024)) return bad();
    if (action.append !== undefined && typeof action.append !== "boolean") return bad();
    if (action.timeoutMs !== undefined && (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 100 || action.timeoutMs > 60_000)) return bad();
  } else return bad();
}
