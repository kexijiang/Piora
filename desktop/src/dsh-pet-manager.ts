import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { installPet, petEnvironment, removePetDirectory, preparePetRuntime } from "./dsh-pet-install.js";
import { DSH_PET_VERSION, PetTaskProjection, type DshPetAction, type DshPetStatus, type DshPetProgress, type PetTaskSnapshot } from "./dsh-pet-types.js";

import { petNetwork, type PetNetwork } from "./dsh-pet-network.js";

interface Runtime { pid: number; port: number; token: string }
interface Options {
  root: string;
  network?: () => PetNetwork;
  tasks: () => Promise<PetTaskSnapshot[]>;
  openSettings: (url: string) => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  closeSettings: () => void;
}

export class DshPetManager {
  private phase: DshPetStatus["phase"] = "stopped";
  private error: string | null = null;
  private progress: DshPetProgress | null = null;
  private preferences = { autoStart: false, syncTasks: true };
  private child: ChildProcess | undefined;
  private runtime: Runtime | undefined;
  private operation: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private stopping = false;
  private disposed = false;
  private projection = new PetTaskProjection();
  private lastWork: string | undefined;
  private stdout = "";

  constructor(private readonly options: Options) {
    mkdirSync(options.root, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(join(options.root, "preferences.json"), "utf8"));
      this.preferences = { autoStart: saved.autoStart === true, syncTasks: saved.syncTasks !== false };
    } catch { /* Optional preferences default to off. */ }
  }

  status(): DshPetStatus {
    const installed = this.installed();
    return { version: DSH_PET_VERSION, installed, phase: !installed && this.phase === "stopped" ? "absent" : this.phase,
      ...this.preferences, error: this.error, progress: this.progress };
  }

  private installed(): boolean {
    try {
      const value = JSON.parse(readFileSync(join(this.options.root, "installed", "piora-adapter.json"), "utf8"));
      return value.version === DSH_PET_VERSION && value.adapter === 1 && existsSync(this.entry());
    } catch { return false; }
  }

  private entry(): string { return join(this.options.root, "installed", "node_modules", "dsh-pet", "lib", "standalone.js"); }

  setPreferences(value: unknown): DshPetStatus {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preferences");
    for (const [key, setting] of Object.entries(value)) {
      if (!["autoStart", "syncTasks"].includes(key) || typeof setting !== "boolean") throw new Error("Invalid preferences");
    }
    const next = { ...this.preferences, ...value };
    const file = join(this.options.root, "preferences.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.preferences = next;
    this.lastWork = undefined;
    this.projection.reset();
    void this.syncTasks();
    return this.status();
  }

  restore(): void {
    if (this.preferences.autoStart && this.installed()) void this.action("start");
  }

  async action(action: DshPetAction): Promise<DshPetStatus> {
    if (this.disposed) throw new Error("Desktop extension is shutting down");
    if (action === "cancel") {
      if (!["installing", "starting"].includes(this.phase)) throw new Error("No cancellable operation");
      this.controller?.abort();
      await this.operation;
      this.error = null;
      this.phase = "stopped";
      return this.status();
    }
    if (action === "folder") { await this.options.openFolder(this.options.root); return this.status(); }
    if (action === "settings") {
      if (!this.runtime || this.phase !== "running") throw new Error("Start DSH Pet first");
      await this.options.openSettings(`http://127.0.0.1:${this.runtime.port}/standalone-ai/#token=${this.runtime.token}`);
      return this.status();
    }
    if (!["install", "start", "stop", "uninstall"].includes(action)) throw new Error("Unknown desktop extension action");
    if (this.operation) throw new Error("A desktop extension operation is already in progress");
    this.error = null;
    this.controller = new AbortController();
    this.operation = this.perform(action, this.controller.signal).catch(error => {
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = "error";
    }).finally(() => { this.operation = undefined; this.controller = undefined; this.progress = null; });
    return this.status();
  }

  private async perform(action: DshPetAction, signal: AbortSignal): Promise<void> {
    if (action === "install") {
      if (this.installed()) throw new Error("DSH Pet is already installed");
      this.phase = "installing";
      await installPet(this.options.root, signal, value => { this.progress = value; }, this.options.network?.() ?? petNetwork());
      this.phase = "stopped";
    } else if (action === "start") {
      if (this.child) return;
      if (!this.installed()) throw new Error("Install DSH Pet first");
      this.phase = "starting";
      this.stdout = "";
      await preparePetRuntime(join(this.options.root, "installed", "node_modules", "dsh-pet"));
      mkdirSync(join(this.options.root, "home", "electron-profile"), { recursive: true });
      const port = await reservePort();
      signal.throwIfAborted();
      // The IPC pipe closes even after a Piora crash. Stop the host as well as its
      // upstream helper, whose own parent-PID guard only watches this host.
      const runner = join(this.options.root, "host-runner.cjs");
      writeFileSync(runner, `process.once('disconnect', () => {\n  const force = setTimeout(() => process.exit(1), 5000); force.unref();\n  process.emit('SIGTERM');\n});\nprocess.argv.splice(1, 1);\nimport(require('node:url').pathToFileURL(process.argv[1]).href).catch(() => process.exit(1));\n`);
      const child = spawn(process.execPath, [runner, this.entry(), "--port", String(port)], {
        cwd: this.options.root, env: petEnvironment(this.options.root, process.env, this.options.network?.() ?? petNetwork()), windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      this.child = child;
      const collect = (data: Buffer) => { this.stdout = (this.stdout + data.toString()).slice(-3000); };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", error => { this.error = error.message; if (this.child === child) this.child = undefined; });
      child.once("exit", code => {
        if (this.child !== child) return;
        this.child = undefined;
        this.runtime = undefined;
        this.options.closeSettings();
        if (this.timer) clearInterval(this.timer);
        if (!this.stopping && !this.disposed) {
          this.phase = "error";
          this.error = `DSH Pet exited (${code ?? "signal"}). ${this.stdout.replace(/(?:token[=:])[A-Za-z0-9_-]+/gi, "token=[redacted]")}`;
        }
      });
      try {
        for (let attempt = 0; attempt < 120; attempt++) {
          signal.throwIfAborted();
          if (child.exitCode !== null || child.signalCode || this.child !== child || !child.pid) throw new Error(this.error || "DSH Pet failed to start");
          try {
            const manifest = JSON.parse(readFileSync(join(this.options.root, "home", "dsh-pet", "standalone-runtime.json"), "utf8")) as Runtime;
            if (manifest.pid === child.pid && Number.isInteger(manifest.port) && manifest.port > 0 && manifest.port < 65536 && /^[A-Za-z0-9_-]{43}$/.test(manifest.token)) {
              const response = await fetch(`http://127.0.0.1:${manifest.port}/health`, { signal: AbortSignal.timeout(1500) });
              if (response.ok) { this.runtime = manifest; break; }
            }
          } catch { /* The manifest is atomically replaced during startup. */ }
          await delay(250, undefined, { signal });
        }
        if (!this.runtime) throw new Error("DSH Pet startup timed out");
        this.phase = "running";
        this.projection.reset();
        this.lastWork = undefined;
        this.timer = setInterval(() => { void this.syncTasks(); }, 1500);
        this.timer.unref();
        await this.syncTasks();
      } catch (error) { await this.stop(); throw error; }
    } else {
      await this.stop();
      if (action === "uninstall") {
        this.setPreferences({ autoStart: false });
        await removePetDirectory(this.options.root, join(this.options.root, "installed"));
      }
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    if (!this.runtime) throw new Error("DSH Pet is not running");
    return fetch(`http://127.0.0.1:${this.runtime.port}${path}`, { ...init,
      headers: { "Content-Type": "application/json", "x-dsh-pet-token": this.runtime.token }, signal: AbortSignal.timeout(3000) });
  }

  private async syncTasks(): Promise<void> {
    if (this.polling || this.phase !== "running" || !this.runtime) return;
    this.polling = true;
    const runtime = this.runtime;
    try {
      const state = this.preferences.syncTasks ? this.projection.update(await this.options.tasks()) : null;
      if (this.runtime !== runtime || this.phase !== "running") return;
      const signature = JSON.stringify(state);
      if (this.lastWork === signature) return;
      const response = await this.request("/dsh-pet-7340/work-status", state === null ? { method: "DELETE" } : {
        method: "POST", body: JSON.stringify({ state, task: null }),
      });
      if (!response.ok) throw new Error(`Task sync failed: HTTP ${response.status}`);
      this.lastWork = signature;
    } catch { this.lastWork = undefined; /* Retry transient connection failures on the next tick. */ }
    finally { this.polling = false; }
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    this.phase = "stopping";
    this.options.closeSettings();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const child = this.child;
    if (child) {
      if (this.runtime) await this.request("/shutdown", { method: "POST" }).catch(() => {});
      for (let attempt = 0; attempt < 30 && child.exitCode === null && !child.signalCode; attempt++) await delay(100);
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGKILL");
        for (let attempt = 0; attempt < 30 && child.exitCode === null && !child.signalCode; attempt++) await delay(100);
        if (child.exitCode === null && !child.signalCode) throw new Error("DSH Pet did not stop");
      }
      // Upstream helpers also watch their host PID and exit when it disappears.
    }
    this.child = undefined;
    this.runtime = undefined;
    this.stopping = false;
    this.phase = "stopped";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort();
    await this.operation;
    await this.stop();
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Cannot allocate pet port")); return; }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}
