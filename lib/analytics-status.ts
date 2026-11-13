import { analyticsStore } from "./analytics-telemetry";
import {
  readAnalyticsConfig,
  DEFAULT_ANALYTICS_POLICY,
} from "../desktop/src/analytics-store.mts";
import type { AnalyticsPolicy } from "../desktop/src/analytics-store.mts";

/** Deliberately excludes enrollment keys, DPAPI data, usernames and queued payloads. */
export function readOrganizationAnalyticsStatus() {
  const config = readAnalyticsConfig(),
    store = analyticsStore();
  if (!config || !store)
    return {
      supported: process.platform === "win32",
      configured: false,
      enabled: false,
    };
  const policy =
    store.get<AnalyticsPolicy>("policy") ?? DEFAULT_ANALYTICS_POLICY;
  return {
    supported: true,
    configured: true,
    enabled: policy.enabled,
    backend_url: config.backend_url,
    organization_name: store.get<string>("organization_name") ?? null,
    installation_id: store.installationId,
    registered: store.get<boolean>("registered") ?? false,
    queue_events: store.health().events,
    last_success_at: store.get<number>("last_success_at") ?? null,
    next_due_at: store.get<number>("next_due_at") ?? null,
    last_error: store.get<string>("last_error") ?? null,
    upload_paused: store.get<boolean>("upload_paused") ?? false,
    interval_min_minutes: Math.round(policy.interval_min_seconds / 60),
    interval_max_minutes: Math.round(policy.interval_max_seconds / 60),
  };
}
