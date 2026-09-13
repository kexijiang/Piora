import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function checkDirectory(root: string, create: boolean): void {
  if (!existsSync(root) && create) {
    let parent = dirname(root);
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    if (relative(parent, realpathSync(parent))) throw new Error("Discovery directory must not follow links.");
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(root, realpathSync(root))) throw new Error("Discovery directory must not follow links.");
  if (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Error("Discovery directory must be private to the current user.");
}
export class RemoteDiscoveryLease {
  readonly path: string;
  private readonly instanceId = randomUUID();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly root: string;
  constructor(private input: { root: string; serverId: string; port: number; host?: string; now?: () => number }) {
    if (!UUID.test(input.serverId) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || ![undefined, "127.0.0.1", "[::1]"].includes(input.host)) throw new Error("Discovery requires a valid identity and loopback port.");
    this.root = resolve(input.root); this.path = join(this.root, process.pid + "-" + this.instanceId + ".json");
  }
  publish(): void {
    if (this.stopped) return;
    checkDirectory(this.root, true);
    const updatedAt = this.input.now?.() ?? Date.now();
    writePrivateFileAtomicSync(this.path, JSON.stringify({ version: 1, protocol: "piora.remote.discovery.v1", serverId: this.input.serverId, instanceId: this.instanceId, pid: process.pid, address: "http://" + (this.input.host ?? "127.0.0.1") + ":" + this.input.port + "/api/remote/v1", updatedAt, expiresAt: updatedAt + 90000 }) + "\n");
  }
  start(): void {
    if (this.stopped || this.timer) return;
    this.publish();
    this.timer = setInterval(() => { try { this.publish(); } catch { this.stop(); } }, 20000);
    this.timer.unref();
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer); this.timer = undefined;
    try {
      checkDirectory(this.root, false); const stat = lstatSync(this.path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096 && JSON.parse(readFileSync(this.path, "utf8")).instanceId === this.instanceId) unlinkSync(this.path);
    } catch {}
  }
}
declare global {
  var __pioraRemoteDiscovery: Promise<RemoteDiscoveryLease | undefined> | undefined;
}
export function startRemoteDiscovery(): Promise<RemoteDiscoveryLease | undefined> {
  const port = Number(process.env.PORT);
  const configuredHost = process.env.PI_WEB_HOSTNAME;
  if (process.env.PIORA_DISCOVERY_DISABLED === "1" || !Number.isInteger(port) || port < 1 || port > 65535 || configuredHost && !["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::"].includes(configuredHost)) return Promise.resolve(undefined);
  if (globalThis.__pioraRemoteDiscovery) return globalThis.__pioraRemoteDiscovery;
  globalThis.__pioraRemoteDiscovery = import("./remote-control-store").then(async ({ getRemoteServerId }) => {
    const serverId = await getRemoteServerId();
    const host = configuredHost === "::1" || configuredHost === "[::1]" || !configuredHost && process.env.HOSTNAME === "::1" ? "[::1]" : "127.0.0.1";
    const lease = new RemoteDiscoveryLease({ root: process.env.PIORA_DISCOVERY_DIR ?? join(homedir(), ".piora", "services"), serverId, port, host });
    lease.start(); process.once("exit", () => lease.stop()); return lease;
  }).catch((error) => { globalThis.__pioraRemoteDiscovery = undefined; throw error; });
  return globalThis.__pioraRemoteDiscovery;
}
