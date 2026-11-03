import type { PromptRunIdentity } from "../prompt-run-registry";
import { MiniAppError } from "./limits";
import { MINI_APP_ENVIRONMENT_TTL, validateMiniAppEnvironmentReport, type MiniAppEnvironmentReport } from "./environment-protocol";

interface WindowEnvironment { report: MiniAppEnvironmentReport; expires: number }
interface PendingEnvironment { environment: WindowEnvironment; expires: number }
interface RunEnvironment { sessionId: string; environment?: WindowEnvironment }

/** Availability only. No permissions, generated flags, durable grants or global GPU default. */
export class MiniAppEnvironmentStore {
  private readonly windows = new Map<string, WindowEnvironment>();
  private readonly pending = new Map<string, PendingEnvironment>();
  private readonly runs = new Map<string, RunEnvironment>();
  constructor(private readonly now: () => number = Date.now) {}
  private submissionKey(sessionId: string, submissionId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !/^[a-zA-Z0-9_.:-]{1,512}$/.test(submissionId)) throw new MiniAppError("ENVIRONMENT", "Invalid submission environment identity");
    return `${sessionId}/${submissionId}`;
  }
  private trim(): void {
    const now = this.now();
    for (const [id, entry] of this.windows) if (entry.expires <= now) this.windows.delete(id);
    for (const [id, entry] of this.pending) if (entry.expires <= now) this.pending.delete(id);
  }
  report(value: unknown, expectedDigest: string): WindowEnvironment {
    this.trim(); const report = validateMiniAppEnvironmentReport(value);
    if (report.rendererDigest !== expectedDigest) throw new MiniAppError("ENVIRONMENT", "Renderer resources changed; probe again");
    const previous = this.windows.get(report.instance);
    if (previous && (report.epoch < previous.report.epoch || report.sequence <= previous.report.sequence)) throw new MiniAppError("STALE_ENVIRONMENT", "A newer window environment is already recorded");
    if (previous && report.epoch === previous.report.epoch) {
      if (report.rendererDigest !== previous.report.rendererDigest || report.webgl !== previous.report.webgl) throw new MiniAppError("ENVIRONMENT", "Changed graphics resources require a new environment epoch");
      previous.report = report; previous.expires = this.now() + MINI_APP_ENVIRONMENT_TTL; return previous;
    }
    if (!previous && this.windows.size >= 128) throw new MiniAppError("LIMIT", "Too many active window environments");
    const environment = { report, expires: this.now() + MINI_APP_ENVIRONMENT_TTL };
    // Replacing this object revokes every old binding, even when IDs are reused.
    this.windows.set(report.instance, environment); return environment;
  }
  prepare(sessionId: string, submissionId: string, value: unknown, expectedDigest: string): void {
    const key = this.submissionKey(sessionId, submissionId), environment = this.report(value, expectedDigest), previous = this.pending.get(key);
    if (previous && previous.environment !== environment) throw new MiniAppError("ENVIRONMENT", "The original submission belongs to another environment");
    if (!previous && this.pending.size >= 512) throw new MiniAppError("LIMIT", "Too many pending environment bindings");
    this.pending.set(key, { environment, expires: this.now() + 5 * 60_000 });
  }
  bind(identity: PromptRunIdentity): void {
    if (this.runs.has(identity.runId)) return;
    this.trim();
    if (this.runs.size >= 256) this.runs.delete(this.runs.keys().next().value!);
    let pending: PendingEnvironment | undefined;
    if (identity.source === "ui" && identity.submissionId) {
      try { const key = this.submissionKey(identity.sessionId, identity.submissionId); pending = this.pending.get(key); this.pending.delete(key); }
      catch { /* Other prompt sources and older submission formats have no graphics report. */ }
    }
    // A run with no originating environment stays unavailable if a late report arrives.
    this.runs.set(identity.runId, { sessionId: identity.sessionId, environment: pending?.environment });
  }
  webgl(identity: PromptRunIdentity | undefined, currentDigest: string): boolean {
    if (!identity) return false;
    const binding = this.runs.get(identity.runId), environment = binding?.environment;
    return binding?.sessionId === identity.sessionId && !!environment && environment.expires > this.now()
      && this.windows.get(environment.report.instance) === environment && environment.report.rendererDigest === currentDigest && environment.report.webgl;
  }
  revoke(instance: string, epoch: number, sequence: number): void {
    const environment = this.windows.get(instance);
    if (environment && epoch >= environment.report.epoch && sequence > environment.report.sequence) {
      // Retain a tombstone until expiry so an earlier heartbeat cannot revive it.
      this.windows.set(instance, { expires: this.now() + MINI_APP_ENVIRONMENT_TTL,
        report: { ...environment.report, epoch: Math.max(epoch, environment.report.epoch), sequence, webgl: false } });
    }
  }
  release(identity: PromptRunIdentity): void { if (this.runs.get(identity.runId)?.sessionId === identity.sessionId) this.runs.delete(identity.runId); }
}

declare global { var __pioraMiniAppEnvironments: MiniAppEnvironmentStore | undefined }
export const miniAppEnvironments = () => globalThis.__pioraMiniAppEnvironments ??= new MiniAppEnvironmentStore();
