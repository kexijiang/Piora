import { requireRemotePrincipal } from "@/lib/remote-control-auth";
import { remoteErrorResponse } from "@/lib/remote-control-response";

export const dynamic = "force-dynamic";

const endpoints = [
  { method: "GET", path: "/api/remote/v1/capabilities", scope: "capabilities.read" },
  { method: "GET", path: "/api/remote/v1/models", scope: "session.create" },
  { method: "GET", path: "/api/remote/v1/sessions", scope: "session.state.read" },
  { method: "POST", path: "/api/remote/v1/sessions", scope: "session.create", idempotencyRequired: true },
  { method: "GET", path: "/api/remote/v1/sessions/{sessionId}/state", scope: "session.state.read" },
  { method: "GET", path: "/api/remote/v1/sessions/{sessionId}/history", scope: "session.history.read" },
  { method: "GET", path: "/api/remote/v1/sessions/{sessionId}/tools", scope: "session.tools.read" },
  { method: "POST", path: "/api/remote/v1/sessions/{sessionId}/messages", scope: "session.message.send", idempotencyRequired: true },
  { method: "POST", path: "/api/remote/v1/sessions/{sessionId}/steer", scope: "session.steer", idempotencyRequired: true },
  { method: "POST", path: "/api/remote/v1/sessions/{sessionId}/abort", scope: "session.abort" },
  { method: "GET", path: "/api/remote/v1/sessions/{sessionId}/events", scope: "session.events.read", transport: "sse" },
  { method: "GET", path: "/api/remote/v1/sessions/{sessionId}/content-events", scope: "session.history.read", transport: "sse", additionalScope: "session.events.read" },
  { method: "GET", path: "/api/remote/v1/commands/{commandId}", scope: "session.messages.read" },
] as const;

export async function GET(request: Request) {
  try {
    const principal = requireRemotePrincipal(request, "capabilities.read");
    return Response.json({
      protocol: "piora.remote.v1",
      features: { contentStream: principal.scopes.has("session.history.read") && principal.scopes.has("session.events.read"), sessionPolicies: ["notes", "agent"], models: principal.scopes.has("session.create") },
      authentication: { scheme: "Bearer" },
      grantedScopes: [...principal.scopes],
      allowedSessionIds: [...principal.allowedSessionIds],
      endpoints: endpoints.filter((endpoint) => principal.scopes.has(endpoint.scope)),
      sessionCreation: {
        fields: ["cwd", "name", "provider", "modelId", "thinkingLevel", "policy"],
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        runtimeProfile: "process-owned",
      },
      sessionIntrospection: { toolsEndpointIncludesCommands: true },
      extensionLoading: "best-effort",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
