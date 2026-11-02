import { MiniAppFrameHost } from "./frame-host";
import { MINI_APP_RENDERER_PROTOCOL, type MiniAppEnvironmentReport, type MiniAppGraphicsReport } from "./environment-protocol";
import { isAnswerStateEnabled, registerAnswerEnvironmentStop } from "../answer-output-client";

const endpoint = "/api/mini-app/environment";
interface Configuration { enabled: boolean; protocol: string; rendererDigest: string }
let client: WindowEnvironmentClient | undefined;

class WindowEnvironmentClient {
  private readonly instance = crypto.randomUUID();
  private readonly lifetime = new AbortController();
  private readonly container = document.createElement("div");
  private host?: MiniAppFrameHost;
  private graphics?: MiniAppGraphicsReport;
  private digest = "";
  private epoch = 0;
  private sequence = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private tail: Promise<void> = Promise.resolve();
  private unregister?: () => void;
  stopped = false;

  constructor() {
    this.container.setAttribute("aria-hidden", "true");
    this.container.style.cssText = "position:fixed;left:-10000px;top:0;width:2px;height:2px;overflow:hidden;pointer-events:none";
    document.body.append(this.container);
    this.unregister = registerAnswerEnvironmentStop(() => this.stop());
    window.addEventListener("pagehide", () => this.stop(), { signal: this.lifetime.signal });
    window.addEventListener("piora-mini-app-graphics-lost", () => this.stop(), { signal: this.lifetime.signal });
  }
  private serialize(work: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(work); this.tail = operation.catch(() => undefined); return operation;
  }
  private report(): MiniAppEnvironmentReport {
    return { protocol: MINI_APP_RENDERER_PROTOCOL, webgl: this.graphics?.webgl === true, instance: this.instance, epoch: this.epoch, sequence: ++this.sequence, rendererDigest: this.digest };
  }
  private async post(action: "prepare" | "heartbeat", submission?: { sessionId: string; submissionId: string }): Promise<void> {
    if (this.stopped) throw new Error("Window environment stopped");
    const response = await fetch(endpoint, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(3000)]), body: JSON.stringify({ action, report: this.report(), ...submission }) });
    if (!response.ok) throw new Error("Window environment was not accepted");
  }
  prepare(config: Configuration, sessionId: string, submissionId: string): Promise<void> {
    return this.serialize(async () => {
      if (this.stopped) throw new Error("Window environment stopped");
      if (!this.host || this.digest !== config.rendererDigest || !this.graphics?.webgl) {
        this.host?.dispose(); this.host = undefined; this.graphics = undefined;
        this.digest = config.rendererDigest; const epoch = ++this.epoch;
        const host = await MiniAppFrameHost.create(this.container, { signal: this.lifetime.signal, onEvent: () => {},
          onError: () => this.stop(), onEnvironment: report => { if (epoch === this.epoch && this.graphics?.webgl && !report.webgl) this.stop(); } });
        if (this.stopped || host.rendererDigest !== config.rendererDigest) { host.dispose(); throw new Error("Renderer changed during environment probe"); }
        this.host = host; this.graphics = await host.probeEnvironment();
      }
      await this.post("prepare", { sessionId, submissionId });
      this.heartbeat ??= setInterval(() => { void this.serialize(() => this.post("heartbeat")).catch(() => this.stop()); }, 15_000);
    });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined;
    if (this.digest) {
      ++this.epoch; this.graphics = { protocol: MINI_APP_RENDERER_PROTOCOL, webgl: false };
      // A later sequence tombstones earlier in-flight heartbeats. Expiry covers
      // browser crashes and failed close notifications.
      void fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
        body: JSON.stringify({ action: "revoke", report: this.report() }) }).catch(() => undefined);
    }
    this.lifetime.abort(); this.host?.dispose(); this.host = undefined; this.container.remove();
    this.unregister?.(); this.unregister = undefined;
  }
}

/** Called by the generic answer-output preflight, never from generated content. */
export async function prepareMiniAppEnvironment(sessionId: string, submissionId: string): Promise<void> {
  const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("Window environment configuration unavailable");
  const config = await response.json() as Configuration;
  if (!config.enabled || !isAnswerStateEnabled()) { client?.stop(); client = undefined; return; }
  if (config.protocol !== MINI_APP_RENDERER_PROTOCOL || !/^[0-9a-f]{64}$/.test(config.rendererDigest)) throw new Error("Unsupported window environment configuration");
  if (!client || client.stopped) client = new WindowEnvironmentClient();
  const preparing = client;
  try { await preparing.prepare(config, sessionId, submissionId); }
  catch (error) { preparing.stop(); throw error; }
}
export function stopMiniAppEnvironment(): void { client?.stop(); client = undefined; }
