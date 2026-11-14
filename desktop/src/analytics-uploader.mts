import { randomInt, randomUUID, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostname, userInfo } from "node:os";
import {
  AnalyticsStore,
  DEFAULT_ANALYTICS_POLICY,
  validateAnalyticsPolicy,
  type AnalyticsConfig,
  type AnalyticsPolicy,
} from "./analytics-store.mjs";
interface Credential {
  credential_id: string;
  secret: string;
  expires_at?: string;
}
interface Vault {
  registration: Record<string, unknown>;
  current: Credential;
  pending?: Credential;
  rotation_id?: string;
}
interface SecureStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(text: string): Promise<Buffer>;
  decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
type Fetcher = typeof fetch;
class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number,
  ) {
    super("ANALYTICS_HTTP_" + status);
  }
}
export function jitterSeconds(min: number, max: number): number {
  return randomInt(Math.ceil(min), Math.floor(max) + 1);
}
export function retryDelay(failures: number, retryAfter = 0): number {
  return (
    Math.max(
      5,
      jitterSeconds(0, Math.min(1800, 30 * 2 ** Math.min(failures, 10))),
      retryAfter,
    ) + jitterSeconds(0, 30)
  );
}
export class AnalyticsUploader {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private vault!: Vault;
  private failures = 0;
  private constructor(
    readonly store: AnalyticsStore,
    private readonly config: AnalyticsConfig,
    private readonly secure: SecureStorage,
    private readonly fetcher: Fetcher = fetch,
  ) {}
  static async create(
    store: AnalyticsStore,
    config: AnalyticsConfig,
    secure: SecureStorage,
    fetcher: Fetcher = fetch,
  ): Promise<AnalyticsUploader> {
    const uploader = new AnalyticsUploader(store, config, secure, fetcher);
    await uploader.initialize();
    return uploader;
  }
  private async initialize(): Promise<void> {
    const { store, secure } = this;
    if (!(await secure.isAsyncEncryptionAvailable()))
      throw new Error("ANALYTICS_DPAPI_UNAVAILABLE");
    const file = join(store.directory, "credentials.dpapi");
    if (existsSync(file)) {
      const decrypted = await secure.decryptStringAsync(readFileSync(file));
      this.vault = JSON.parse(decrypted.result) as Vault;
      if (decrypted.shouldReEncrypt) await this.saveVault();
    } else {
      const current = {
        credential_id: randomUUID(),
        secret: randomBytes(32).toString("base64url"),
      };
      this.vault = {
        current,
        registration: {
          registration_id: randomUUID(),
          installation_id: store.installationId,
          credential: current,
          windows_username: userInfo().username.slice(0, 128),
          device_label: hostname().slice(0, 128),
          app_version: store.get<string>("app_version") ?? "unknown",
          sdk_version: "pi-runtime",
          protocol_version: "1.0",
          capabilities: [
            "desktop_activity",
            "query",
            "model_usage",
            "file_write",
            "file_edit",
          ],
        },
      };
      await this.saveVault();
    }
  }
  private async saveVault(): Promise<void> {
    const file = join(this.store.directory, "credentials.dpapi"),
      temp = file + ".tmp";
    writeFileSync(
      temp,
      await this.secure.encryptStringAsync(JSON.stringify(this.vault)),
      { mode: 0o600, flush: true },
    );
    renameSync(temp, file);
  }
  private policy(): AnalyticsPolicy {
    return (
      this.store.get<AnalyticsPolicy>("policy") ?? DEFAULT_ANALYTICS_POLICY
    );
  }
  start(): void {
    const due = this.store.get<number>("next_due_at"),
      p = this.policy();
    this.schedule(
      due && due > Date.now()
        ? Math.ceil((due - Date.now()) / 1000)
        : jitterSeconds(
            p.initial_delay_min_seconds,
            p.initial_delay_max_seconds,
          ),
    );
  }
  reconnect(): void {
    if (this.stopped) return;
    const p = this.policy();
    this.schedule(
      jitterSeconds(p.reconnect_min_seconds, p.reconnect_max_seconds),
    );
  }
  private schedule(seconds: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    const due = Date.now() + seconds * 1000;
    this.store.set("next_due_at", due);
    const arm = () => {
      if (this.stopped) return;
      // Node timers overflow above ~24.8 days. Keep the persisted deadline and
      // wait in bounded chunks instead of turning a long interval into a 1ms loop.
      this.timer = setTimeout(() => {
        if (Date.now() < due) arm();
        else void this.flush();
      }, Math.min(2_147_483_647, Math.max(0, due - Date.now())));
      this.timer.unref();
    };
    arm();
  }
  private async request(
    path: string,
    body: unknown,
    credential: string,
    idempotency?: string,
  ): Promise<Record<string, unknown>> {
    const started = Date.now(),
      response = await this.fetcher(this.config.backend_url + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Piora-Capabilities": "configurable-sync-interval",
          Authorization: "Bearer " + credential,
          ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    if (!response.ok)
      throw new UploadError(
        response.status,
        Math.min(
          7200,
          Math.max(0, Number(response.headers.get("Retry-After")) || 0),
        ),
      );
    const envelope = (await response.json()) as {
      data: Record<string, unknown>;
      meta: { server_time: string };
    };
    if (
      Date.now() - started < 5000 &&
      Number.isFinite(Date.parse(envelope.meta?.server_time))
    ) {
      const offset =
        Date.parse(envelope.meta.server_time) - (started + Date.now()) / 2;
      if (Math.abs(offset) <= 86400000) {
        this.store.set("clock_offset_ms", Math.round(offset));
        this.store.set("clock_sync_at", new Date().toISOString());
      }
    }
    if (envelope.data.policy)
      this.store.set("policy", validateAnalyticsPolicy(envelope.data.policy));
    return envelope.data;
  }
  private bearer(credential = this.vault.current): string {
    return "pa1." + credential.credential_id + "." + credential.secret;
  }
  private async register(): Promise<void> {
    if (this.store.get<boolean>("registered")) return;
    if (!this.config.enrollment_key)
      throw new Error("ANALYTICS_ENROLLMENT_REQUIRED");
    const registrationId = this.vault.registration.registration_id as string;
    const result = await this.request(
      "/v1/installations/register",
      this.vault.registration,
      this.config.enrollment_key,
      registrationId,
    );
    this.vault.current.expires_at = result.credential_expires_at as string;
    await this.saveVault();
    this.store.set("registered", true);
    this.store.set("organization_name", result.organization_name);
  }
  private async rotate(): Promise<void> {
    if (!this.vault.pending) {
      this.vault.pending = {
        credential_id: randomUUID(),
        secret: randomBytes(32).toString("base64url"),
      };
      this.vault.rotation_id = randomUUID();
    }
    await this.saveVault();
    const body = {
      rotation_id: this.vault.rotation_id,
      next_credential: this.vault.pending,
    };
    let result: Record<string, unknown>;
    try {
      result = await this.request(
        "/v1/installations/credentials/rotate",
        body,
        this.bearer(),
        this.vault.rotation_id,
      );
    } catch (error) {
      if (!(error instanceof UploadError) || error.status !== 401) throw error;
      result = await this.request(
        "/v1/installations/credentials/rotate",
        body,
        this.bearer(this.vault.pending),
        this.vault.rotation_id,
      );
    }
    this.vault.current = {
      ...this.vault.pending,
      expires_at: result.expires_at as string,
    };
    delete this.vault.pending;
    delete this.vault.rotation_id;
    await this.saveVault();
  }
  async flush(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.register();
      if (
        this.vault.pending ||
        (this.vault.current.expires_at &&
          Date.parse(this.vault.current.expires_at) - Date.now() < 7 * 86400000)
      )
        await this.rotate();
      let policy = this.policy();
      this.store.prune(policy);
      const health = this.store.health(),
        dropped = this.store.get<number>("dropped_total") ?? 0,
        quarantined = this.store.get<number>("quarantined_total") ?? 0;
      let pendingHealth = this.store.get<{
        id: string;
        dropped: number;
        quarantined: number;
      }>("pending_health");
      if (
        !pendingHealth ||
        !this.store.db
          .prepare("SELECT 1 FROM outbox WHERE event_id=?")
          .get(pendingHealth.id)
      ) {
        const id = this.store.record(
          "client.health",
          "health:" + randomUUID(),
          {
            queue_events: String(health.events),
            queue_bytes: String(health.bytes),
            dropped_events: String(
              Math.max(
                0,
                dropped - (this.store.get<number>("reported_dropped") ?? 0),
              ),
            ),
            quarantined_events: String(
              Math.max(
                0,
                quarantined -
                  (this.store.get<number>("reported_quarantined") ?? 0),
              ),
            ),
            clock_offset_ms: this.store.get<number>("clock_offset_ms") ?? 0,
            clock_sync_at: this.store.get<string>("clock_sync_at") ?? null,
            codes: this.store.get<string[]>("health_codes") ?? [],
          },
          this.now(),
        )!;
        pendingHealth = { id, dropped, quarantined };
        this.store.set("pending_health", pendingHealth);
      }
      let sentBatches = 0;
      while (sentBatches < 5 && !this.stopped) {
        policy = this.policy();
        const events = this.store.batch(policy);
        if (!events.length) break;
        const result = await this.request(
          "/v1/telemetry/batches",
          {
            batch_id: randomUUID(),
            protocol_version: "1.0",
            client_sent_at: this.now(),
            policy_version: policy.version,
            events,
          },
          this.bearer(),
        );
        this.store.acknowledge(
          events.map((e) => e.event_id),
          result as {
            accepted_event_ids: string[];
            duplicate_event_ids: string[];
            rejected_events: { event_id: string; code: string }[];
          },
        );
        const confirmed = [
          ...(result.accepted_event_ids as string[]),
          ...(result.duplicate_event_ids as string[]),
        ];
        if (confirmed.includes(pendingHealth.id)) {
          this.store.set("reported_dropped", pendingHealth.dropped);
          this.store.set("reported_quarantined", pendingHealth.quarantined);
          this.store.set("pending_health", null);
        }
        this.store.set("last_success_at", Date.now());
        this.store.set("last_error", null);
        this.store.set("upload_paused", false);
        sentBatches++;
        this.failures = 0;
        if (result.credential_rotation_due) await this.rotate();
        if (
          typeof result.retry_after_seconds === "number" &&
          result.retry_after_seconds > 0
        ) {
          this.schedule(result.retry_after_seconds + jitterSeconds(0, 30));
          return;
        }
        if (this.store.health().events && sentBatches < 5)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, jitterSeconds(10, 30) * 1000);
            timer.unref();
          });
      }
      policy = this.policy();
      this.schedule(
        policy.enabled && this.store.health().events
          ? jitterSeconds(300, 600)
          : jitterSeconds(
              policy.interval_min_seconds,
              policy.interval_max_seconds,
            ),
      );
    } catch (error) {
      const auth =
        error instanceof UploadError && [401, 403].includes(error.status);
      try {
        this.store.set(
          "last_error",
          error instanceof UploadError
            ? "HTTP_" + error.status
            : "UPLOAD_FAILED",
        );
        if (auth) {
          this.store.set("upload_paused", true);
          return;
        }
        this.schedule(
          retryDelay(
            this.failures++,
            error instanceof UploadError ? error.retryAfter : 0,
          ),
        );
      } catch {
        /* A failed SQLite disk must not reject into the desktop event loop. */
      }
    } finally {
      this.busy = false;
    }
  }
  now(): string {
    return new Date(
      Date.now() + (this.store.get<number>("clock_offset_ms") ?? 0),
    ).toISOString();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
