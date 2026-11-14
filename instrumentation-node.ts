import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { startRemoteControlConnector } from "@/lib/remote-control-connector";
import { bootstrapTeamRuntime } from "@/lib/team-bootstrap";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();
  void Promise.all([import("@/lib/analytics-telemetry"), import("@/lib/session-control-store")])
    .then(([analytics, { SessionControlStore }]) => analytics.startAnalyticsJournalReconciliation(new SessionControlStore().root))
    .catch(() => { /* Organization statistics remain optional and never block startup. */ });
  void import("@/lib/remote-discovery")
    .then(({ startRemoteDiscovery }) => startRemoteDiscovery())
    .catch(() => { console.warn("[piora-remote] Local discovery unavailable; manual connections remain available."); });
  // Keep the automation/session runtime out of the instrumentation entry's
  // synchronous dependency graph. Bundling it here pulls the full agent SDK
  // into Next's startup compiler and can stall development startup. The
  // dynamic import still starts recovery as soon as the Node runtime is ready.
  void import("@/lib/automation-runtime")
    .then(({ startAutomationRuntime }) => startAutomationRuntime())
    .catch((error) => {
      console.error("[piora-automations] startup failed:", error instanceof Error ? error.message : String(error));
    });
  startRemoteControlConnector();
  void bootstrapTeamRuntime().catch((error) => {
    console.error("[piora-team] startup recovery failed:", error instanceof Error ? error.message : String(error));
  });
}
