import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Windows has no wasOpenedAtLogin flag. Unmarked legacy login items are ambiguous. */
export function analyticsLaunchReason(
  args: readonly string[],
  legacyLoginItem: boolean | undefined,
): "manual" | "autostart" | "update" | "unknown" {
  if (args.includes("--updated")) return "update";
  if (args.includes("--piora-autostart")) return "autostart";
  return legacyLoginItem === false ? "manual" : "unknown";
}

export interface AnalyticsConfig {
  backend_url: string;
  enrollment_key?: string;
  enabled: boolean;
}
export interface AnalyticsPolicy {
  version: number;
  enabled: boolean;
  interval_min_seconds: number;
  interval_max_seconds: number;
  initial_delay_min_seconds: number;
  initial_delay_max_seconds: number;
  reconnect_min_seconds: number;
  reconnect_max_seconds: number;
  max_batch_events: number;
  max_batch_bytes: number;
  queue_max_days: number;
  queue_max_bytes: number;
}
export const DEFAULT_ANALYTICS_POLICY: AnalyticsPolicy = {
  version: 1,
  enabled: true,
  interval_min_seconds: 1500,
  interval_max_seconds: 2100,
  initial_delay_min_seconds: 60,
  initial_delay_max_seconds: 300,
  reconnect_min_seconds: 120,
  reconnect_max_seconds: 600,
  max_batch_events: 500,
  max_batch_bytes: 262144,
  queue_max_days: 30,
  queue_max_bytes: 268435456,
};
export interface AnalyticsEvent {
  event_id: string;
  event_seq: string;
  source_key: string;
  event_type: string;
  occurred_at: string;
  app_launch_id: string;
  app_version: string;
  payload: Record<string, unknown>;
}
const fields: Record<string, readonly string[]> = {
  "desktop.started": ["reason"],
  "desktop.opened": ["activation_id", "reason"],
  "desktop.activity": [
    "start_at",
    "end_at",
    "runtime_ms",
    "active_ranges",
    "sample_interval_ms",
    "time_quality",
  ],
  "query.submitted": [
    "query_id",
    "command_id",
    "source",
    "trigger",
    "accepted_at",
  ],
  "query.updated": ["query_id", "revision", "status", "run_id"],
  "run.started": [
    "run_id",
    "query_id",
    "parent_run_id",
    "source",
    "started_at",
  ],
  "run.finished": [
    "run_id",
    "outcome",
    "duration_ms",
    "waiting_ms",
    "finished_at",
  ],
  "model.started": [
    "call_id",
    "query_id",
    "run_id",
    "provider",
    "model",
    "source",
    "started_at",
  ],
  "model.finished": [
    "id",
    "query_id",
    "run_id",
    "provider",
    "model",
    "source",
    "status",
    "started_at",
    "finished_at",
    "duration_ms",
    "usage_status",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
  ],
  "file.changed": [
    "operation_id",
    "run_id",
    "query_id",
    "tool_call_id",
    "file_key",
    "language",
    "file_category",
    "kind",
    "added_lines",
    "deleted_lines",
    "measurement_status",
  ],
  "client.health": [
    "queue_events",
    "queue_bytes",
    "dropped_events",
    "quarantined_events",
    "clock_offset_ms",
    "clock_sync_at",
    "codes",
  ],
};
export function analyticsDirectory(): string | undefined {
  return process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Piora", "telemetry")
    : undefined;
}
export function readAnalyticsConfig(): AnalyticsConfig | undefined {
  const directory = analyticsDirectory();
  if (!directory) return undefined;
  try {
    const file = join(directory, "config.json");
    if (!existsSync(file)) return undefined;
    const input = JSON.parse(readFileSync(file, "utf8")) as AnalyticsConfig;
    const url = new URL(input.backend_url);
    if (
      !input.enabled ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return undefined;
    return {
      backend_url: url.origin,
      enabled: true,
      ...(typeof input.enrollment_key === "string"
        ? { enrollment_key: input.enrollment_key }
        : {}),
    };
  } catch {
    return undefined;
  }
}
export function stableAnalyticsId(
  installation: string,
  source: string,
): string {
  const bytes = createHash("sha1")
    .update(installation + ":" + source)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 80;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const h = bytes.toString("hex");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-" +
    h.slice(12, 16) +
    "-" +
    h.slice(16, 20) +
    "-" +
    h.slice(20)
  );
}
export function validateAnalyticsPolicy(value: unknown): AnalyticsPolicy {
  const p = value as AnalyticsPolicy;
  if (
    !p ||
    Object.keys(DEFAULT_ANALYTICS_POLICY).some((k) => !(k in p)) ||
    !Number.isInteger(p.version) ||
    p.version < 1 ||
    typeof p.enabled !== "boolean" ||
    p.interval_min_seconds <= 0 ||
    p.interval_max_seconds < p.interval_min_seconds ||
    !Number.isSafeInteger(p.interval_min_seconds) ||
    !Number.isSafeInteger(p.interval_max_seconds) ||
    !Number.isFinite(new Date(Date.now() + p.interval_max_seconds * 1000).getTime()) ||
    p.initial_delay_min_seconds < 0 ||
    p.initial_delay_max_seconds < p.initial_delay_min_seconds ||
    p.initial_delay_max_seconds > 600 ||
    p.reconnect_min_seconds < 0 ||
    p.reconnect_max_seconds < p.reconnect_min_seconds ||
    p.reconnect_max_seconds > 1800 ||
    p.max_batch_events < 1 ||
    p.max_batch_events > 500 ||
    p.max_batch_bytes < 4096 ||
    p.max_batch_bytes > 262144 ||
    p.queue_max_days < 1 ||
    p.queue_max_days > 30 ||
    p.queue_max_bytes < 1048576 ||
    p.queue_max_bytes > 268435456 ||
    Object.entries(p).some(([k, v]) => k !== "enabled" && !Number.isInteger(v))
  )
    throw new Error("INVALID_ANALYTICS_POLICY");
  return p;
}
export class AnalyticsStore {
  readonly db: DatabaseSync;
  readonly installationId: string;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "outbox.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,event_seq INTEGER UNIQUE NOT NULL,source_key TEXT UNIQUE NOT NULL,json TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS receipts(source_key TEXT PRIMARY KEY,event_id TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS quarantine(event_id TEXT PRIMARY KEY,code TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.get("installation_id"))
        this.set("installation_id", randomUUID());
      if (!this.get("enabled_at")) this.set("enabled_at", Date.now());
      if (!this.get("file_salt"))
        this.set("file_salt", randomBytes(32).toString("hex"));
      this.installationId = this.get<string>("installation_id")!;
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw e;
    }
  }
  get<T>(key: string): T | undefined {
    const r = this.db
      .prepare("SELECT value FROM state WHERE key=?")
      .get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  record(
    type: string,
    sourceKey: string,
    payload: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): string | undefined {
    const policy =
      this.get<AnalyticsPolicy>("policy") ?? DEFAULT_ANALYTICS_POLICY;
    const keys = fields[type];
    if (
      !keys ||
      Object.keys(payload).some((k) => !keys.includes(k)) ||
      keys.some((k) => !(k in payload))
    )
      throw new Error("TELEMETRY_FIELDS_REJECTED");
    if (
      type === "desktop.activity" &&
      (payload.active_ranges as Record<string, unknown>[]).some((r) =>
        Object.keys(r).some((k) => k !== "start_at" && k !== "end_at"),
      )
    )
      throw new Error("TELEMETRY_FIELDS_REJECTED");
    if (sourceKey.length > 512) throw new Error("TELEMETRY_KEY_TOO_LONG");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ type, payload, occurredAt }))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db
        .prepare("SELECT event_id,hash FROM receipts WHERE source_key=?")
        .get(sourceKey) as { event_id: string; hash: string } | undefined;
      if (receipt) {
        this.db.exec("COMMIT");
        return receipt.event_id;
      }
      if (!policy.enabled && type !== "client.health") {
        this.db
          .prepare("INSERT INTO receipts VALUES(?,?,?,?)")
          .run(
            sourceKey,
            stableAnalyticsId(this.installationId, sourceKey),
            fingerprint,
            Date.now(),
          );
        this.db.exec("COMMIT");
        return undefined;
      }
      const seq = BigInt(this.get<string>("next_seq") ?? "0") + BigInt(1),
        eventId = stableAnalyticsId(this.installationId, sourceKey);
      const event: AnalyticsEvent = {
        event_id: eventId,
        event_seq: String(seq),
        source_key: sourceKey,
        event_type: type,
        occurred_at: occurredAt,
        app_launch_id: this.get<string>("app_launch_id") ?? this.installationId,
        app_version: this.get<string>("app_version") ?? "unknown",
        payload,
      };
      const json = JSON.stringify(event);
      if (Buffer.byteLength(json) > 200000)
        throw new Error("TELEMETRY_EVENT_TOO_LARGE");
      this.db
        .prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)")
        .run(
          eventId,
          seq,
          sourceKey,
          json,
          Buffer.byteLength(json),
          Date.now(),
        );
      this.db
        .prepare("INSERT INTO receipts VALUES(?,?,?,?)")
        .run(sourceKey, eventId, fingerprint, Date.now());
      this.set("next_seq", String(seq));
      this.db.exec("COMMIT");
      return eventId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  batch(policy: AnalyticsPolicy): AnalyticsEvent[] {
    const rows = this.db
      .prepare(
        "SELECT json,bytes FROM outbox " +
          (policy.enabled
            ? ""
            : "WHERE json_extract(json,'$.event_type')='client.health' ") +
          "ORDER BY event_seq LIMIT ?",
      )
      .all(policy.max_batch_events) as { json: string; bytes: number }[];
    let bytes = 512;
    const events: AnalyticsEvent[] = [];
    for (const r of rows) {
      const event = JSON.parse(r.json) as AnalyticsEvent;
      if (r.bytes + 513 > policy.max_batch_bytes) {
        this.acknowledge([event.event_id], {
          accepted_event_ids: [],
          duplicate_event_ids: [],
          rejected_events: [
            { event_id: event.event_id, code: "EVENT_EXCEEDS_BATCH_POLICY" },
          ],
        });
        continue;
      }
      if (bytes + r.bytes + 1 > policy.max_batch_bytes) break;
      events.push(event);
      bytes += r.bytes + 1;
    }
    return events;
  }
  acknowledge(
    sent: string[],
    result: {
      accepted_event_ids: string[];
      duplicate_event_ids: string[];
      rejected_events: { event_id: string; code: string }[];
    },
  ): void {
    const ids = [
        ...result.accepted_event_ids,
        ...result.duplicate_event_ids,
        ...result.rejected_events.map((x) => x.event_id),
      ],
      expected = new Set(sent);
    if (
      ids.length !== expected.size ||
      new Set(ids).size !== ids.length ||
      ids.some((x) => !expected.has(x))
    )
      throw new Error("INVALID_TELEMETRY_ACK");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of result.rejected_events)
        this.db
          .prepare("INSERT OR IGNORE INTO quarantine VALUES(?,?,?)")
          .run(item.event_id, item.code, Date.now());
      for (const id of ids)
        this.db.prepare("DELETE FROM outbox WHERE event_id=?").run(id);
      this.set(
        "quarantined_total",
        (this.get<number>("quarantined_total") ?? 0) +
          result.rejected_events.length,
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  health(): { events: number; bytes: number } {
    const r = this.db
      .prepare(
        "SELECT count(*) AS events,COALESCE(sum(bytes),0) AS bytes FROM outbox",
      )
      .get() as { events: number; bytes: number };
    return r;
  }
  prune(policy: AnalyticsPolicy): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let dropped = Number(
        this.db
          .prepare("DELETE FROM outbox WHERE created_at<?")
          .run(Date.now() - policy.queue_max_days * 86400000).changes,
      );
      let total = this.health().bytes;
      while (total > policy.queue_max_bytes) {
        const r = this.db
          .prepare(
            "SELECT event_id,bytes FROM outbox ORDER BY event_seq LIMIT 1",
          )
          .get() as { event_id: string; bytes: number } | undefined;
        if (!r) break;
        this.db.prepare("DELETE FROM outbox WHERE event_id=?").run(r.event_id);
        total -= r.bytes;
        dropped++;
      }
      this.set(
        "dropped_total",
        (this.get<number>("dropped_total") ?? 0) + dropped,
      );
      this.db
        .prepare("DELETE FROM receipts WHERE created_at<?")
        .run(Date.now() - 90 * 86400000);
      this.db
        .prepare("DELETE FROM quarantine WHERE created_at<?")
        .run(Date.now() - 7 * 86400000);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close(): void {
    this.db.close();
  }
}
