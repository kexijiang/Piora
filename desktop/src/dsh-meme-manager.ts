import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { installMeme, memeNetwork, DSH_MEME_VERSION, prepareMemeRuntime } from "./dsh-meme-install.js";
import { petEnvironment, removePetDirectory } from "./dsh-pet-install.js";
import { preparePetNetwork, type PetNetwork } from "./dsh-pet-network.js";
import type { DshPetProgress } from "./dsh-pet-types.js";
export interface MemeStatus { version: string; installed: boolean; phase: string; autoStart: boolean; error: string | null; progress: DshPetProgress | null }
export class DshMemeManager {
  private child: ChildProcess | undefined;
  private port = 0;
  private token = "";
  private phase = "stopped";
  private error: string | null = null;
  private progress: DshPetProgress | null = null;
  private autoStart = false;
  private operation: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private disposed = false;
  constructor(private options: { root: string; host: string; network?: () => PetNetwork; model: (input: unknown) => Promise<unknown>; openPanel: (url: string, token: string) => Promise<void>; closePanel: () => void }) {
    mkdirSync(options.root, { recursive: true });
    try { this.autoStart = JSON.parse(readFileSync(join(options.root, "preferences.json"), "utf8")).autoStart === true; } catch {}
  }
  status(): MemeStatus {
    let installed = false;
    try { const m = JSON.parse(readFileSync(join(this.options.root, "installed", "piora-adapter.json"), "utf8")); installed = m.version === DSH_MEME_VERSION && m.adapter === 1 && existsSync(join(this.options.root, "installed", "node_modules", "dsh-meme", "index.js")); } catch {}
    return { version: DSH_MEME_VERSION, installed, phase: !installed && this.phase === "stopped" ? "absent" : this.phase, error: this.error, progress: this.progress, autoStart: this.autoStart };
  }
  restore() { if (this.autoStart && this.status().installed) this.action("start"); }
  setAutoStart(value: boolean) {
    this.autoStart = value;
    const file = join(this.options.root, "preferences.json");
    writeFileSync(file + ".tmp", JSON.stringify({ autoStart: value })); renameSync(file + ".tmp", file);
    return this.status();
  }
  action(action: string): MemeStatus {
    if (this.disposed) throw new Error("DSH Meme is shutting down");
    if (action === "cancel") { this.controller?.abort(); return this.status(); }
    if (!["install", "start", "stop", "uninstall", "settings"].includes(action)) throw new Error("Invalid DSH Meme action");
    if (this.operation) throw new Error("DSH Meme is busy");
    const controller = this.controller = new AbortController(); this.error = null;
    this.operation = this.perform(action, controller.signal).catch(error => { this.error = controller.signal.aborted ? "Cancelled" : error.message; this.phase = "error"; })
      .finally(() => { this.operation = undefined; this.controller = undefined; this.progress = null; });
    return this.status();
  }
  private async perform(action: string, signal: AbortSignal): Promise<void> {
    if (action === "install") {
      if (this.status().installed) throw new Error("Already installed"); this.phase = "installing";
      await installMeme(this.options.root, signal, value => { this.progress = value; }, this.options.network?.() || memeNetwork()); this.phase = "stopped"; return;
    }
    if (action === "stop" || action === "uninstall") {
      await this.stop();
      if (action === "uninstall") await removePetDirectory(this.options.root, join(this.options.root, "installed"));
      return;
    }
    if (!this.status().installed) throw new Error("Install DSH Meme first");
    if (!this.child) await this.start(signal);
    if (action === "settings") await this.options.openPanel(`http://127.0.0.1:${this.port}/memes-panel`, this.token);
  }
  private async start(signal: AbortSignal) {
    this.phase = "starting";
    const network = await preparePetNetwork(this.options.root, this.options.network?.() || memeNetwork()); signal.throwIfAborted();
    await prepareMemeRuntime(this.options.root);
    this.token = randomBytes(32).toString("hex");
    const env = petEnvironment(this.options.root, process.env, network);
    env.DSH_MEME_HOME = join(this.options.root, "home");
    const child = this.child = spawn(process.execPath, [this.options.host], { cwd: this.options.root, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr?.resume();
    child.on("message", (value: unknown) => {
      const message = value as { type?: string; id?: string; payload?: unknown };
      if (message.type === "model" && typeof message.id === "string") {
        void this.options.model(message.payload).then(value => { if (child.connected) child.send({ type: "model-result", id: message.id, value }); }, error => { if (child.connected) child.send({ type: "model-result", id: message.id, error: error.message }); });
      }
    });
    child.once("exit", () => { if (this.child === child) { this.child = undefined; this.port = 0; if (this.phase !== "stopping") { this.phase = "error"; this.error = "DSH Meme host exited"; this.options.closePanel(); } } });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("DSH Meme startup timed out")), 30000);
        const abort = () => finish(new Error("Cancelled"));
        const exited = () => finish(new Error("DSH Meme exited before readiness"));
        const message = (v: unknown) => { const m = v as { type?: string; port?: number; error?: string }; if (m.type === "ready" && m.port) { this.port = m.port; finish(); } else if (m.type === "failure") finish(new Error(m.error)); };
        const finish = (error?: Error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); child.off("message", message); child.off("error", finish); child.off("exit", exited); if (error) reject(error); else resolve(); };
        child.on("message", message); child.once("error", finish); child.once("exit", exited); signal.addEventListener("abort", abort, { once: true });
        child.send({ type: "init", root: this.options.root, token: this.token });
      });
      signal.throwIfAborted(); this.phase = "running";
    } catch (error) { await this.stop(); throw error; }
  }
  async http(path: string, method = "GET", body?: string) {
    if (this.phase !== "running" || !this.port) throw new Error("DSH Meme is not running");
    if (!/^\/(?:__piora|dsh-memes(?:-api|-export)?)(?:[/?]|$)/.test(path) || path.includes("\\") || path.includes("#") || body && body.length > 44 * 1024 * 1024) throw new Error("Invalid meme request");
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, { method, ...(body !== undefined ? { body, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" } } : { headers: { Authorization: `Bearer ${this.token}` } }), signal: AbortSignal.timeout(125000), redirect: "error" });
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error("Empty meme response");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 40 * 1024 * 1024) throw new Error("Meme response too large");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return { status: response.status, mime: response.headers.get("content-type") || "application/octet-stream", data: bytes.toString("base64") };
  }
  private async stop() {
    this.phase = "stopping"; this.options.closePanel(); const child = this.child;
    if (child?.connected) child.disconnect();
    for (let i = 0; child && i < 30 && child.exitCode === null && !child.signalCode; i++) await delay(100);
    if (child && child.exitCode === null && !child.signalCode) { child.kill(); for (let i = 0; i < 30 && child.exitCode === null && !child.signalCode; i++) await delay(100); }
    if (child && child.exitCode === null && !child.signalCode) throw new Error("DSH Meme did not stop");
    this.child = undefined; this.port = 0; this.phase = "stopped";
  }
  async dispose() { this.disposed = true; this.controller?.abort(); await this.operation; await this.stop(); }
}
