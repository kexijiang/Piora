import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const WINAPP_VERSION = "0.7.1";
const MAX_OUTPUT = 1024 * 1024;
const MAX_TEXT = 12_000;
const ACTIONS = ["invoke", "select", "toggle", "toggle-on", "toggle-off", "expand", "collapse"] as const;
const DIRECTIONS = ["up", "down", "left", "right"] as const;
const POSITIONS = ["top", "bottom"] as const;

type Schema = { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
function schema(required: string[], optional: Record<string, unknown> = {}): Schema {
  const fields: Record<string, unknown> = { ...(required.includes("hwnd") ? { hwnd: { oneOf: [{ type: "string" }, { type: "integer" }], description: "Window handle from uia_list_windows (decimal or 0x hex)." } } : {}),
    ...(required.includes("selector") ? { selector: { type: "string", description: "Current UIA slug or unique AutomationId from uia_inspect/uia_find." } } : {}),
    ...optional };
  return { type: "object", properties: fields, required, additionalProperties: false };
}

export const WINAPP_UIA_OPERATIONS: Record<string, { description: string; inputSchema: Schema }> = {
  uia_list_windows: { description: "List visible Windows windows and their handles; begin here.", inputSchema: schema([]) },
  uia_inspect: { description: "Inspect the UIA control tree in one window; use its current slugs for actions.", inputSchema: schema(["hwnd"], { depth: { type: "integer", minimum: 1, maximum: 10 }, interactive: { type: "boolean" } }) },
  uia_find: { description: "Find UIA elements in one window; zero matches means a visual fallback may be needed.", inputSchema: schema(["hwnd", "query"], { query: { type: "string" }, root: { type: "string" }, controlType: { type: "string" }, className: { type: "string" }, max: { type: "integer", minimum: 1, maximum: 100 } }) },
  uia_invoke: { description: "Perform exactly one UIA pattern action on a current, unique control. No mouse click fallback.", inputSchema: schema(["hwnd", "selector", "action"], { action: { type: "string", enum: ACTIONS } }) },
  uia_set_value: { description: "Set an editable control through UIA ValuePattern/RangeValuePattern, without typing keys.", inputSchema: schema(["hwnd", "selector", "value"], { value: { type: "string" } }) },
  uia_get_value: { description: "Read a control's value using UIA patterns.", inputSchema: schema(["hwnd", "selector"], { root: { type: "string" }, controlType: { type: "string" }, className: { type: "string" } }) },
  uia_get_property: { description: "Read UIA properties, including toggle and selection state.", inputSchema: schema(["hwnd", "selector"], { property: { type: "string" }, root: { type: "string" }, controlType: { type: "string" }, className: { type: "string" } }) },
  uia_wait_for: { description: "Wait for a UIA control, its value, or its disappearance.", inputSchema: schema(["hwnd", "selector"], { timeoutMs: { type: "integer", minimum: 1, maximum: 45_000 }, property: { type: "string" }, value: { type: "string" }, gone: { type: "boolean" }, root: { type: "string" }, controlType: { type: "string" }, className: { type: "string" } }) },
  uia_scroll: { description: "Scroll a UIA container with ScrollPattern; wheel input is not used.", inputSchema: schema(["hwnd", "selector"], { direction: { type: "string", enum: DIRECTIONS }, to: { type: "string", enum: POSITIONS } }) },
};

export function winAppPath(): string {
  return process.env.PIORA_WINAPP_PATH?.trim() || resolve(process.cwd(), "node_modules", "@microsoft", "winappcli", "bin", "win-x64", "winapp.exe");
}

function field(input: Record<string, unknown>, name: string, limit = 512): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error(`${name} must be a nonempty string of at most ${limit} characters.`);
  return value;
}
function valueField(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length > 16_000 || value.includes("\0")) throw new Error(`${name} must be a string of at most 16000 characters.`);
  return value;
}
function optionalField(input: Record<string, unknown>, name: string, flag: string, args: string[]) {
  if (input[name] !== undefined) args.push(flag, field(input, name));
}
function optionalValueField(input: Record<string, unknown>, name: string, flag: string, args: string[]) {
  if (input[name] !== undefined) args.push(flag, valueField(input, name));
}
function intField(input: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value as number;
}
function enumField(input: Record<string, unknown>, name: string, values: readonly string[]): string {
  const value = field(input, name, 32);
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  return value;
}

export function buildWinAppArgs(operation: string, input: Record<string, unknown>): string[] {
  const definition = WINAPP_UIA_OPERATIONS[operation];
  if (!definition) throw new Error("Unknown UIA operation. Call help first.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("UIA input must be an object.");
  const allowed = definition.inputSchema.properties;
  for (const key of Object.keys(input)) if (!(key in allowed)) throw new Error(`Unexpected UIA argument: ${key}`);
  for (const key of definition.inputSchema.required) if (input[key] === undefined) throw new Error(`Missing UIA argument: ${key}`);
  const commands: Record<string, string> = { uia_list_windows: "list-windows", uia_inspect: "inspect", uia_find: "search", uia_invoke: "invoke",
    uia_set_value: "set-value", uia_get_value: "get-value", uia_get_property: "get-property", uia_wait_for: "wait-for", uia_scroll: "scroll" };
  const args = ["ui", commands[operation], "--json"];
  if (operation !== "uia_list_windows") {
    const rawHwnd = input.hwnd;
    const hwnd = typeof rawHwnd === "number" && Number.isSafeInteger(rawHwnd) && rawHwnd > 0 ? String(rawHwnd) : field(input, "hwnd", 20);
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(hwnd)) throw new Error("hwnd must be a decimal or hexadecimal window handle.");
    args.push("--window", hwnd);
  }
  if (operation === "uia_inspect") {
    const depth = intField(input, "depth", 1, 10);
    if (depth !== undefined) args.push("--depth", String(depth));
    if (input.interactive !== undefined) {
      if (typeof input.interactive !== "boolean") throw new Error("interactive must be a boolean.");
      if (input.interactive) args.push("--interactive");
    }
  }
  if (operation === "uia_find") {
    optionalField(input, "root", "--root", args);
    optionalField(input, "controlType", "--type", args);
    optionalField(input, "className", "--class-name", args);
    const max = intField(input, "max", 1, 100);
    if (max !== undefined) args.push("--max", String(max));
  }
  if (["uia_get_value", "uia_get_property", "uia_wait_for"].includes(operation)) {
    optionalField(input, "root", "--root", args);
    optionalField(input, "controlType", "--type", args);
    optionalField(input, "className", "--class-name", args);
  }
  if (operation === "uia_invoke") args.push("--action", enumField(input, "action", ACTIONS));
  if (operation === "uia_get_property" || operation === "uia_wait_for") optionalField(input, "property", "--property", args);
  if (operation === "uia_wait_for") {
    const timeout = intField(input, "timeoutMs", 1, 45_000);
    if (timeout !== undefined) args.push("--timeout", String(timeout));
    optionalValueField(input, "value", "--value", args);
    if (input.gone !== undefined) {
      if (typeof input.gone !== "boolean") throw new Error("gone must be a boolean.");
      if (input.gone) args.push("--gone");
    }
  }
  if (operation === "uia_scroll") {
    if ((input.direction === undefined) === (input.to === undefined)) throw new Error("Specify exactly one of direction or to.");
    if (input.direction !== undefined) args.push("--direction", enumField(input, "direction", DIRECTIONS));
    else args.push("--to", enumField(input, "to", POSITIONS));
  }
  const positional = operation === "uia_find" ? [field(input, "query")] : operation === "uia_list_windows" || operation === "uia_inspect" ? [] : [field(input, "selector")];
  if (operation === "uia_set_value") positional.push(valueField(input, "value"));
  if (positional.length) args.push("--", ...positional);
  return args;
}

export function parseWinAppResult(stdout: string, stderr: string, exitCode: number | null) {
  const raw = (stdout.trim() || stderr.trim());
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`winapp CLI returned invalid JSON (exit ${exitCode}): ${raw.slice(0, 500)}`); }
  let truncated = false;
  const compact = (item: unknown, depth = 0): unknown => {
    if (typeof item === "string" && item.length > 1000) { truncated = true; return `${item.slice(0, 1000)}…`; }
    if (!item || typeof item !== "object") return item;
    if (depth > 8) { truncated = true; return "[nested output omitted]"; }
    const entries = Array.isArray(item) ? item : Object.entries(item);
    if (entries.length > 100) truncated = true;
    return Array.isArray(item) ? item.slice(0, 100).map(value => compact(value, depth + 1)) : Object.fromEntries(Object.entries(item).slice(0, 100).map(([key, value]) => [key.slice(0, 200), compact(value, depth + 1)]));
  };
  let text = JSON.stringify(value);
  if (text.length > MAX_TEXT) {
    value = compact(value); text = JSON.stringify(value);
    if (Array.isArray(value)) {
      while (text.length > MAX_TEXT && value.length) { value.pop(); truncated = true; text = JSON.stringify(value); }
    } else if (text.length > MAX_TEXT) {
      truncated = true; text = JSON.stringify({ truncated: true, preview: text.slice(0, 5000) });
    }
  }
  return { content: [{ type: "text" as const, text }], isError: exitCode !== 0,
    ...(truncated ? { details: { truncated: true, nextAction: "Inspect a smaller window or use a narrower selector." } } : {}) };

}

export async function killOwnedProcess(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") await new Promise<void>((done) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, () => done());
  });
  else { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
}

export class WinAppUiaRuntime {
  private active?: ChildProcessWithoutNullStreams;
  private path: string;
  constructor(path = winAppPath()) { this.path = path; }
  state() { return { available: existsSync(this.path), version: WINAPP_VERSION, busy: !!this.active }; }
  async check(signal?: AbortSignal) {
    if (!existsSync(this.path)) throw new Error(`Bundled winapp CLI ${WINAPP_VERSION} is missing: ${this.path}`);
    const result = await this.execute(["--version"], 10_000, signal);
    if (result.exitCode !== 0 || result.stdout.trim().split(/\s+/).at(-1) !== WINAPP_VERSION) throw new Error(`Bundled winapp CLI version must be ${WINAPP_VERSION}.`);
  }
  async call(operation: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const args = buildWinAppArgs(operation, input);
    const timeout = operation === "uia_wait_for" ? (input.timeoutMs as number | undefined ?? 5_000) + 10_000 : 60_000;
    const result = await this.execute(args, timeout, signal);
    return parseWinAppResult(result.stdout, result.stderr, result.exitCode);
  }
  async stop() {
    const child = this.active;
    await killOwnedProcess(child?.pid);
    child?.kill();
  }
  private async execute(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    signal?.throwIfAborted();
    if (this.active) throw new Error("A winapp UIA operation is already running.");
    const child = spawn(this.path, args, { windowsHide: true, shell: false, env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: "1" } });
    this.active = child;
    try {
      return await new Promise((done, fail) => {
        let stdout = "", stderr = "", failure: Error | undefined;
        const interrupt = (reason: Error) => {
          if (failure) return;
          failure = reason;
          void killOwnedProcess(child.pid).finally(() => child.kill());
        };
        const timer = setTimeout(() => interrupt(new Error("winapp UIA timed out; the action may have completed. Inspect the UI again before acting.")), timeoutMs);
        const onAbort = () => interrupt(new Error("winapp UIA was cancelled; inspect the UI again before acting."));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
          if (failure) return;
          if (kind === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
          if (stdout.length + stderr.length > MAX_OUTPUT) interrupt(new Error("winapp UIA output exceeded 1 MB; inspect a smaller window."));
        };
        child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
        child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
        child.once("error", (error) => { failure ??= error; });
        child.once("close", (exitCode) => {
          clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
          if (failure) fail(failure); else done({ stdout, stderr, exitCode });
        });
      });
    } finally { if (this.active === child) this.active = undefined; }
  }
}
