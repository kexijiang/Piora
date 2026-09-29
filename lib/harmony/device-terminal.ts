import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { loadTerminalPty } from "../terminal-pty";
import { getHarmonyDeviceManager } from "./index";
import { HarmonyError } from "./errors";
import { validateDeviceFilePath, type HarmonyFileScope } from "./device-files";

type Event = { type: "snapshot"; output: string; connected: boolean } | { type: "output"; data: string } | { type: "status"; connected: boolean };
type Listener = (event: Event) => void;

class DeviceTerminal {
  readonly id = randomUUID();
  readonly listeners = new Set<Listener>();
  readonly serial: string;
  readonly leaseToken: string;
  private child: IPty | null = null;
  private output = "";
  private connected = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(serial: string, leaseToken: string, scope: HarmonyFileScope, executable: string) {
    this.serial = serial;
    this.leaseToken = leaseToken;
    const args = ["-t", serial, "shell", ...(scope.kind === "sandbox" ? ["-b", scope.bundleName] : [])];
    try {
      const child = loadTerminalPty().spawn(executable, args, { cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
        name: "xterm-256color", useConptyDll: process.platform === "win32" });
      this.child = child;
      this.connected = true;
      child.onData(data => {
        if (this.child !== child) return;
        const bounded = data.length > 64_000 ? `[earlier terminal output omitted]\r\n${data.slice(-64_000)}` : data;
        this.output = (this.output + bounded).slice(-200_000);
        this.emit({ type: "output", data: bounded });
      });
      child.onExit(() => {
        if (this.child !== child) return;
        if (process.platform === "win32") { try { child.kill(); } catch { /* ConPTY handle already closed. */ } }
        this.child = null;
        this.connected = false;
        this.emit({ type: "status", connected: false });
      });
      this.watchdog = setInterval(() => {
        try {
          const lease = getHarmonyDeviceManager().getState(serial).leases.find(item => item.token === leaseToken);
          if (!lease) this.stop();
        } catch { this.stop(); }
      }, 5_000);
      this.watchdog.unref?.();
    } catch (error) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", error instanceof Error ? error.message : "Interactive HDC shell could not start");
    }
  }

  private emit(event: Event) { for (const listener of this.listeners) { try { listener(event); } catch { /* Subscriber detached. */ } } }
  subscribe(listener: Listener): () => void {
    listener({ type: "snapshot", output: this.output, connected: this.connected });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  input(data: string) {
    if (!this.child || !this.connected) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device shell has exited");
    if (!data || data.length > 16_384) throw new HarmonyError("INVALID_ARGUMENT", "Terminal input must contain at most 16384 characters");
    this.child.write(data);
  }
  resize(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 300 || rows < 5 || rows > 120) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid terminal size");
    }
    this.child?.resize(cols, rows);
  }
  stop() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const child = this.child;
    this.child = null;
    this.connected = false;
    try { child?.kill(); } catch { /* Already exited. */ }
    this.emit({ type: "status", connected: false });
    terminals.delete(this.id);
  }
}

declare global { var __pioraHarmonyDeviceTerminals: Map<string, DeviceTerminal> | undefined; }
const terminals = globalThis.__pioraHarmonyDeviceTerminals ??= new Map<string, DeviceTerminal>();

export async function startDeviceTerminal(serial: string, leaseToken: string, scope: HarmonyFileScope) {
  validateDeviceFilePath(scope, scope.kind === "sandbox" ? "data/storage/el2/base" : "/data/local/tmp");
  const manager = getHarmonyDeviceManager();
  const lease = manager.renewLease(leaseToken);
  if (lease.serial !== serial || lease.owner.kind !== "manual") throw new HarmonyError("LEASE_REQUIRED", "Manual control of this device is required");
  const devices = await manager.listDevices();
  if (!devices.some(device => device.serial === serial && device.state === "online")) throw new HarmonyError("DEVICE_OFFLINE", "Device is offline");
  manager.renewLease(leaseToken);
  const existing = [...terminals.values()].find(item => item.serial === serial);
  if (existing) {
    if (existing.leaseToken !== leaseToken) throw new HarmonyError("LEASE_CONFLICT", "Another device terminal is active");
    return existing.id;
  }
  const hdcPath = manager.getState(serial).runtime.hdcPath;
  if (!hdcPath) throw new HarmonyError("HDC_NOT_FOUND", "HDC is unavailable");
  const terminal = new DeviceTerminal(serial, leaseToken, scope, hdcPath);
  terminals.set(terminal.id, terminal);
  return terminal.id;
}

export function getDeviceTerminal(id: string): DeviceTerminal {
  const terminal = terminals.get(id);
  if (!terminal) throw new HarmonyError("DEVICE_NOT_FOUND", "Device terminal has closed");
  return terminal;
}

export function controlDeviceTerminal(id: string, leaseToken: string, action: "input" | "resize" | "keepalive" | "stop", data?: string, cols?: number, rows?: number) {
  const terminal = getDeviceTerminal(id);
  if (terminal.leaseToken !== leaseToken) throw new HarmonyError("LEASE_REQUIRED", "Manual control of this device is required");
  if (action === "stop") { terminal.stop(); return; }
  const lease = getHarmonyDeviceManager().renewLease(leaseToken);
  if (lease.token !== terminal.leaseToken || lease.serial !== terminal.serial || lease.owner.kind !== "manual") {
    throw new HarmonyError("LEASE_REQUIRED", "Manual control of this device is required");
  }
  if (action === "input") terminal.input(data ?? "");
  else if (action === "resize") terminal.resize(cols ?? 0, rows ?? 0);
}
