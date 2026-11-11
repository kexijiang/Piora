import { existsSync } from "node:fs";
import { getRuntimeUserHomeDirectory as homedir } from "./runtime-home";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { WinAppUiaRuntime, WINAPP_UIA_OPERATIONS, killOwnedProcess } from "./winapp-uia";

export const WINDOWS_MCP_VERSION = "0.8.5";
export const WINDOWS_COMPUTER_TOOLS = ["App", "DisplayInventory", "Snapshot", "Screenshot", "Click", "Type", "Scroll", "Move", "Shortcut", "Wait", "WaitFor", "MultiSelect", "MultiEdit", "Clipboard"] as const;
const TEXT_LIMIT = 12_000;
const PIXEL_ACTIONS = new Set(["Click", "Type", "Scroll", "Move", "Shortcut", "MultiSelect", "MultiEdit"]);
type ComputerContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function compactComputerContent(content: unknown): ComputerContent[] {
  if (!Array.isArray(content)) return [];
  const result: ComputerContent[] = [];
  let remaining = TEXT_LIMIT;
  let imageCount = 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && remaining > 0) {
      const text = block.text.slice(0, remaining);
      remaining -= text.length;
      result.push({ type: "text", text: `${text}${text.length < block.text.length ? "\n[Output truncated; inspect a smaller window.]" : ""}` });
    } else if (block?.type === "image" && typeof block.data === "string" && /^image\/(png|jpeg|webp)$/.test(block.mimeType) && imageCount++ === 0) {
      if (block.data.length <= 4_000_000) result.push({ type: "image", data: block.data, mimeType: block.mimeType });
      else result.push({ type: "text", text: "Screenshot exceeds 3 MB; request a smaller window or use the UI tree." });
    }
  }
  return result;
}

function uvxCommand(): string {
  const configured = process.env.PIORA_UVX_PATH?.trim();
  if (configured) return configured;
  return [join(homedir(), ".local", "bin", "uvx.exe"),
    ...["Python314", "Python313", "Python312", "Python311"].map((version) => join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", version, "Scripts", "uvx.exe")),
  ].find((path) => existsSync(path)) ?? "uvx";
}

/** One physical desktop, one owner. A timed-out action closes its process instead of retrying clicks. */
export class ComputerControlRuntime {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<void>;
  private tools: Tool[] = [];
  private owner?: string;
  private executing = false;
  private stopped = false;
  private lastError?: string;
  private uia = new WinAppUiaRuntime();
  private uiaReady = false;
  private uiaObserved = false;
  private uiaObservedHwnd?: string;
  private displayObserved = false;
  private visualObserved = false;

  state() {
    return { supported: process.platform === "win32", connected: !!this.client && this.uiaReady,
      connecting: !!this.connecting, busy: this.executing, stopped: this.stopped,
      backend: "winapp CLI + Windows-MCP", version: WINDOWS_MCP_VERSION, toolCount: this.tools.length + Object.keys(WINAPP_UIA_OPERATIONS).length,
      windowsMcp: { connected: !!this.client, version: WINDOWS_MCP_VERSION },
      uia: { ...this.uia.state(), connected: this.uiaReady },
      ...(this.lastError ? { error: this.lastError } : {}) };
  }

  resume() { this.stopped = false; }
  async stop() { this.stopped = true; await this.close(); }
  claim(owner: string) {
    if (this.owner && this.owner !== owner) throw new Error("Another task controls this desktop. Wait for it to release control.");
    if (!this.owner) { this.uiaObserved = false; this.uiaObservedHwnd = undefined; this.displayObserved = false; this.visualObserved = false; }
    this.owner = owner;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Computer control was stopped. Resume it in Settings > Extensions.");
    if (process.platform !== "win32") throw new Error("Computer control currently supports Windows only.");
    if (this.client && this.uiaReady) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        if (!this.uiaReady) { await this.uia.check(signal); this.uiaReady = true; }
        if (!this.client) await this.open(signal);
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(signal?: AbortSignal) {
    const client = new Client({ name: "piora-computer", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: uvxCommand(),
      args: ["--python", "3.13", "--from", `windows-mcp==${WINDOWS_MCP_VERSION}`, "windows-mcp", "serve", "--transport", "stdio", "--tools", WINDOWS_COMPUTER_TOOLS.join(",")],
      env: { ANONYMIZED_TELEMETRY: "false", PYTHONIOENCODING: "utf-8", UV_NO_PROGRESS: "1", WINDOWS_MCP_SCREENSHOT_SCALE: "0.5" },
      stderr: "pipe", maxBufferSize: 8 * 1024 * 1024 });
    // Drain dependency/install diagnostics without forwarding host data to the model.
    let diagnostic = "";
    transport.stderr?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    this.transport = transport;
    try {
      await client.connect(transport, { timeout: 180_000, ...(signal ? { signal } : {}) });
      const result = await client.listTools({}, { timeout: 30_000, ...(signal ? { signal } : {}) });
      if (this.stopped || this.transport !== transport) throw new Error("Computer connection was stopped");
      this.tools = result.tools.filter((tool) => (WINDOWS_COMPUTER_TOOLS as readonly string[]).includes(tool.name));
      this.client = client;
      this.lastError = undefined;
      client.onclose = () => { if (this.client === client) { this.client = undefined; this.tools = []; } };
    } catch (error) {
      this.lastError = `${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ""}`;
      if (this.transport === transport) await this.close();
      else await transport.close().catch(() => {});
      throw new Error(`Windows-MCP could not start. Install uv or set PIORA_UVX_PATH, then retry. ${this.lastError}`);
    }
  }

  async help(topic?: string, signal?: AbortSignal) {
    await this.connect(signal);
    if (!topic) return { operations: [
      ...Object.entries(WINAPP_UIA_OPERATIONS).map(([name, operation]) => ({ name, description: operation.description })),
      ...this.tools.map((tool) => ({ name: tool.name, description: this.operationDescription(tool).slice(0, 250) })),
    ] };
    if (WINAPP_UIA_OPERATIONS[topic]) return { name: topic, ...WINAPP_UIA_OPERATIONS[topic] };
    const tool = this.tools.find((item) => item.name === topic);
    if (!tool) throw new Error("Unknown desktop operation. Call help first.");
    return { name: tool.name, description: this.operationDescription(tool), inputSchema: tool.inputSchema };
  }

  private operationDescription(tool: Tool): string {
    const policy = PIXEL_ACTIONS.has(tool.name) ? "Coordinate/keyboard fallback only: inspect UIA controls and capture a fresh screenshot first. "
      : tool.name === "Screenshot" || tool.name === "Snapshot" ? "Use UIA inspection first; request an image only for visual fallback. " : "";
    return `${policy}${tool.description ?? ""}`;
  }

  async call(owner: string, name: string, input: Record<string, unknown>, signal?: AbortSignal) {
    this.claim(owner);
    if (this.executing) throw new Error("A desktop operation is already running.");
    this.executing = true;
    try {
      await this.connect(signal);
      if (WINAPP_UIA_OPERATIONS[name]) {
        const hwnd = name === "uia_list_windows" ? undefined : this.windowIdentity(input.hwnd);
        if (["uia_invoke", "uia_set_value", "uia_scroll"].includes(name) && (!this.uiaObserved || this.uiaObservedHwnd !== hwnd)) {
          throw new Error("Inspect or find controls in this window before a UIA action.");
        }
        const result = await this.uia.call(name, input, signal);
        if (name === "uia_list_windows") { this.uiaObserved = false; this.uiaObservedHwnd = undefined; }
        if (name === "uia_inspect" || name === "uia_find") {
          this.uiaObserved = !result.isError || (name === "uia_find" && !!result.content[0]?.text.includes('"matchCount":0'));
          this.uiaObservedHwnd = this.uiaObserved ? hwnd : undefined;
        }
        this.visualObserved = false;
        return { ...result, backend: "winapp CLI" };
      }
      if (!this.tools.some((tool) => tool.name === name)) throw new Error("Unknown desktop operation. Call help first.");
      if ((name === "Screenshot" || (name === "Snapshot" && input.use_vision === true)) && !this.uiaObserved) {
        throw new Error("Inspect the target window through uia_inspect or uia_find before screenshot fallback.");
      }
      if ((name === "Screenshot" || (name === "Snapshot" && input.use_vision === true)) && !this.displayObserved) {
        throw new Error("Call DisplayInventory to confirm monitor origins and sizes before screenshot fallback.");
      }
      if (PIXEL_ACTIONS.has(name) && !this.visualObserved) {
        throw new Error("Inspect UIA controls and capture a fresh screenshot before coordinate or keyboard fallback.");
      }
      const result = await this.client!.callTool({ name, arguments: input }, undefined, { timeout: 60_000, ...(signal ? { signal } : {}) });
      const content = compactComputerContent(result.content);
      if (name === "DisplayInventory") this.displayObserved = result.isError !== true;
      if (name === "Screenshot" || name === "Snapshot") this.visualObserved = result.isError !== true && content.some((block) => block.type === "image");
      if (PIXEL_ACTIONS.has(name)) this.visualObserved = false;
      return { content, isError: result.isError === true, backend: "Windows-MCP" };
    } catch (error) {
      // Never automatically replay a possibly completed UI mutation.
      await this.close();
      throw error;
    } finally { this.executing = false; }
  }

  async release(owner: string) {
    if (this.owner !== owner) return;
    await this.close();
  }

  private windowIdentity(value: unknown): string | undefined {
    try { return BigInt(value as string | number).toString(); }
    catch { return undefined; }
  }

  private async close() {
    const transport = this.transport;
    this.client = undefined; this.transport = undefined; this.tools = []; this.owner = undefined; this.uiaReady = false;
    this.uiaObserved = false; this.uiaObservedHwnd = undefined; this.displayObserved = false; this.visualObserved = false;
    const pid = transport?.pid;
    // Both helpers are owned child processes; stop their entire trees on cancel.
    await Promise.all([this.uia.stop(), killOwnedProcess(pid ?? undefined)]);
    await transport?.close().catch(() => {});
  }
}

declare global { var __pioraComputerControl: ComputerControlRuntime | undefined; }
export function getComputerControl() { return globalThis.__pioraComputerControl ??= new ComputerControlRuntime(); }
