import { RemoteControlAuthError, remoteAuthErrorResponse } from "./remote-control-auth";
import { SessionMessageRouterError } from "./session-message-router";
import { SessionRuntimeResolverError } from "./session-runtime-resolver";
import { RemoteSessionCreationError } from "./remote-session-creation";

export function remoteErrorResponse(error: unknown): Response {
  if (error instanceof RemoteSessionCreationError) {
    const status = error.code === "REMOTE_CREATION_CONFLICT" ? 409 : error.code === "REMOTE_CREATION_BUSY" ? 503 : 500;
    return Response.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "2" } : {}) } });
  }
  if (error instanceof RemoteControlAuthError) return remoteAuthErrorResponse(error);
  if (error instanceof SessionMessageRouterError) {
    const status = ["SESSION_NOT_FOUND", "SESSION_FILE_INVALID"].includes(error.code) ? 404
      : ["SESSION_BUSY", "STEER_REQUIRES_RUNNING_SESSION", "SESSION_QUEUE_FULL", "COMMAND_DUPLICATE"].includes(error.code) ? 409
        : error.code === "SESSION_MESSAGE_TOO_LARGE" ? 413
          : error.code === "COMMAND_EXPIRED" ? 410 : 400;
    return Response.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof SessionRuntimeResolverError) {
    const status = ["SESSION_NOT_FOUND", "SESSION_FILE_INVALID", "INVALID_SESSION_ID"].includes(error.code) ? 404
      : error.code === "SESSION_PROFILE_MISMATCH" ? 409 : 500;
    return Response.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: error instanceof Error ? error.message : "Remote control request failed.", code: "INVALID_REQUEST" }, { status: 400, headers: { "Cache-Control": "no-store" } });
}
