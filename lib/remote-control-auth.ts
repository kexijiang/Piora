import { authenticateRemoteCapabilityToken, touchRemoteCapabilityToken, readRemoteCapabilityStore } from "./remote-control-store";
import type { RemoteCapabilityPrincipal, RemoteControlScope } from "./remote-control-types";

export type RemoteAuthErrorCode =
  | "REMOTE_TOKEN_REQUIRED"
  | "REMOTE_TOKEN_EXPIRED"
  | "REMOTE_SCOPE_DENIED"
  | "SESSION_NOT_ALLOWED"
  | "RATE_LIMITED";

export class RemoteControlAuthError extends Error {
  constructor(readonly code: RemoteAuthErrorCode, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RemoteControlAuthError";
  }
}
declare global {
  var __pioraRemoteRateLimits: Map<string, { startedAt: number; count: number }> | undefined;
}

function rateLimits(): Map<string, { startedAt: number; count: number }> {
  return globalThis.__pioraRemoteRateLimits ??= new Map();
}

function assertRateLimit(tokenId: string, sessionId?: string): void {
  const key = `${tokenId}:${sessionId ?? "*"}`;
  const now = Date.now();
  const current = rateLimits().get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateLimits().set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= 120) throw new RemoteControlAuthError("RATE_LIMITED", "Remote request rate limit exceeded.", 60);
  current.count += 1;
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  const match = value ? /^Bearer\s+([^\s]+)$/i.exec(value) : null;
  return match?.[1];
}

export function requireRemotePrincipal(request: Request, scope: RemoteControlScope, sessionId?: string): RemoteCapabilityPrincipal {
  const token = bearerToken(request);
  if (!token) throw new RemoteControlAuthError("REMOTE_TOKEN_REQUIRED", "A remote capability token is required.");
  const record = authenticateRemoteCapabilityToken(token);
  if (!record) throw new RemoteControlAuthError("REMOTE_TOKEN_EXPIRED", "The remote capability token is invalid or expired.");
  assertRateLimit(record.id, sessionId);
  if (!record.scopes.includes(scope)) throw new RemoteControlAuthError("REMOTE_SCOPE_DENIED", "The remote capability does not grant this operation.");
  if (sessionId && !record.allowedSessionIds.includes(sessionId)) throw new RemoteControlAuthError("SESSION_NOT_ALLOWED", "The remote capability does not grant this Session.");
  void touchRemoteCapabilityToken(record.id);
  return {
    tokenId: record.id,
    scopes: new Set(record.scopes),
    allowedSessionIds: new Set(record.allowedSessionIds),
    allowedRoomIds: new Set(record.allowedRoomIds),
  };
}

export function remoteAuthErrorResponse(error: unknown): Response {
  if (error instanceof RemoteControlAuthError) {
    const status = error.code === "REMOTE_TOKEN_REQUIRED" || error.code === "REMOTE_TOKEN_EXPIRED" ? 401 : error.code === "RATE_LIMITED" ? 429 : 403;
    return Response.json({ error: error.message, code: error.code }, {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {}),
      },
    });
  }
  return Response.json({ error: "Remote control request failed.", code: "REMOTE_CONTROL_ERROR" }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

export function resetRemoteAuthForTests(): void {
  globalThis.__pioraRemoteRateLimits?.clear();
}

export function assertRemotePrincipalCurrent(principal: RemoteCapabilityPrincipal, scope: RemoteControlScope, sessionId: string): void {
  const token = readRemoteCapabilityStore().tokens.find(record => record.id === principal.tokenId);
  if (!token || token.revokedAt || (token.expiresAt !== undefined && token.expiresAt <= Date.now())) throw new RemoteControlAuthError("REMOTE_TOKEN_EXPIRED", "Remote capability expired or revoked");
  if (!token.scopes.includes(scope)) throw new RemoteControlAuthError("REMOTE_SCOPE_DENIED", "Scope was revoked");
  if (!token.allowedSessionIds.includes(sessionId)) throw new RemoteControlAuthError("SESSION_NOT_ALLOWED", "Session access was revoked");
}
